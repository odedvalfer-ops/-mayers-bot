require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = 'whatsapp:+14155238886';

const ACTIONS = {'1':'טיפול אבנית','2':'ניקיון מערכת הקצפה','3':'טיפול כדורית — יחידת חליטה','4':'החלפת חלק','5':'החלפת מכונה'};
const PARTS = {'1':'נשם','2':'ברז חשמלי','3':'קפוצינטור','4':'יחידת חליטה','5':'טרמובלוק (דוד)'};
const ACTION_MENU = 'מה עשית?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה';
const MORE_MENU = 'עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה';
const PART_MENU = 'איזה חלק?\n1️⃣ נשם\n2️⃣ ברז חשמלי\n3️⃣ קפוצינטור\n4️⃣ יחידת חליטה\n5️⃣ טרמובלוק (דוד)';
const FAULT_WORDS = ['תקלה','לא מושך','לא מקציף','לא עובד','לא נדלק','לא יוצא','לא פועל','להחליף','לא מחמם'];

const sessions = {};

async function searchCustomers(query) {
  const stopWords = new Set(['לא','של','את','עם','על','אל','כי','כן','בלי','רק','תקלה','מושך','מקציף','עובד','נדלק','יוצא','פועל','החלף','מחמם','מגרס']);
  const words = query.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));
  if (!words.length) return [];
  const searchStr = words.join(' ');
  const {data: full} = await supabase.from('customers').select('*').ilike('site_name','%'+searchStr+'%').eq('is_active',true).limit(8);
  if (full && full.length > 0) return full;
  const longest = [...words].sort((a,b) => b.length - a.length)[0];
  const {data} = await supabase.from('customers').select('*').ilike('site_name','%'+longest+'%').eq('is_active',true).limit(8);
  return data || [];
}

async function getHistory(siteCode, limit=2) {
  const {data} = await supabase.from('tickets').select('closed_at,actions').eq('site_code',siteCode).eq('status','closed').order('closed_at',{ascending:false}).limit(limit);
  return data||[];
}

async function countRecent(siteCode, days=60) {
  const since = new Date(Date.now()-days*86400000).toISOString();
  const {count} = await supabase.from('tickets').select('*',{count:'exact',head:true}).eq('site_code',siteCode).gte('opened_at',since);
  return count||0;
}

async function getTechnicians() {
  const {data} = await supabase.from('technicians').select('*').eq('role','field').eq('is_active',true);
  return data||[];
}

async function openTicket(siteCode, location, description, openedBy) {
  const ticketNumber = `KL-${Date.now().toString().slice(-6)}`;
  const {data} = await supabase.from('tickets').insert({ticket_number:ticketNumber,site_code:siteCode,machine_location:location,description,opened_by:openedBy,status:'open'}).select().single();
  return data;
}

async function closeTicket(ticketId, actions, parts) {
  const {data} = await supabase.from('tickets').update({status:'closed',closed_at:new Date().toISOString(),actions,parts}).eq('id',ticketId).select('*,customers(site_name,city,machine_type,location,site_code)').single();
  return data;
}

function formatHistory(hist) {
  if(!hist.length) return '';
  return '\n\n📜 היסטוריה:\n'+hist.map(h=>`🔧 ${(h.closed_at||'?').slice(0,10)} — ${h.actions?h.actions.join(' + '):'לא מצוין'}`).join('\n');
}

function extractClient(msg) {
  let t = msg;
  FAULT_WORDS.forEach(w => { t = t.split(w).join(' '); });
  return t.replace(/[^\u05d0-\u05eaA-Za-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim();
}

async function handleSingleCustomer(session, customer, phone) {
  const machines = await searchCustomers(customer.site_name);
  if(machines.length>1) {
    session.step='select_machine';
    session.machines=machines;
    const list=machines.map((m,i)=>`${i+1}️⃣ ${m.location||'לא מצוין'} | ${m.machine_type}`).join('\n');
    return `יש כמה מכונות ב${customer.site_name}:\n${list}\n\nאיזו מכונה?`;
  }
  return await buildCustomerConfirm(session, customer, phone);
}

async function buildCustomerConfirm(session, customer, phone) {
  session.customer=customer;
  const hist=await getHistory(customer.site_code);
  const recent=await countRecent(customer.site_code);
  const ticket=await openTicket(customer.site_code,customer.location,session.faultDesc,phone);
  session.ticket=ticket;
  session.step='assign_tech';
  const techs=await getTechnicians();
  session.techs=techs;
  const histText=formatHistory(hist);
  let card=`✅ מצאתי:\n📍 ${customer.site_name}`;
  if(customer.location) card+=` | ${customer.location}`;
  card+=`\n🏙️ ${customer.city}\n🔧 ${customer.machine_type}`;
  if(customer.contact_name) card+=`\n👤 ${customer.contact_name}`;
  if(customer.contact_phone) card+=` — ${customer.contact_phone}`;
  card+=histText;
  if(recent>=3) card+=`\n\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  card+=`\n\n✅ תקלה נרשמה — ${ticket.ticket_number}\n\nלאיזה טכנאי לשייך?\n`;
  card+=techs.map((t,i)=>`${i+1}️⃣ ${t.name}`).join('\n');
  return card;
}

async function handleMessage(from, body) {
  const phone=from.replace('whatsapp:','');
  const msg=body.trim();
  if(!sessions[phone]) sessions[phone]={step:'idle'};
  const session=sessions[phone];

  if(session.step==='idle') {
    if(msg.startsWith('סיימתי')) {
      const parts=msg.replace('סיימתי','').trim().split(/\s+/);
      const clientName=parts[0]||'';
      const {data:openTickets}=await supabase.from('tickets').select('*,customers(site_name,site_code,machine_type,location)').eq('status','open').order('opened_at',{ascending:false});
      const matched=(openTickets||[]).filter(t=>t.customers?.site_name?.includes(clientName));
      if(!matched.length) return `לא מצאתי תקלה פתוחה עבור "${clientName}"`;
      if(matched.length===1) {
        session.ticketId=matched[0].id;
        session.siteCode=matched[0].customers?.site_code;
        session.actions=[];
        session.parts=[];
        session.step='closing_action';
        return ACTION_MENU;
      }
      session.step='select_close_ticket';
      session.openTickets=matched;
      return 'איזו תקלה לסגור?\n'+matched.map((t,i)=>`${i+1}️⃣ ${t.customers?.site_name}${t.customers?.location?' | '+t.customers.location:''}`).join('\n');
    }

    const isFault=FAULT_WORDS.some(w=>msg.includes(w));
    if(isFault) {
      const clientName=extractClient(msg);
      if(clientName.length<2) return 'מה שם הלקוח?';
      const customers=await searchCustomers(clientName);
      if(!customers.length) return `לא מצאתי לקוח בשם "${clientName}" — בדוק את השם ונסה שוב.`;
      session.faultDesc=msg;
      if(customers.length===1) return await handleSingleCustomer(session,customers[0],phone);
      session.step='select_customer';
      session.customers=customers;
      return 'מצאתי כמה תוצאות:\n'+customers.map((c,i)=>`${i+1}️⃣ ${c.site_name} — ${c.city}${c.location?' | '+c.location:''}`).join('\n');
    }
    return null;
  }

  if(session.step==='select_customer') {
    const idx=parseInt(msg)-1;
    if(idx>=0&&idx<(session.customers||[]).length) return await handleSingleCustomer(session,session.customers[idx],phone);
    return 'בחר מספר מהרשימה';
  }

  if(session.step==='select_machine') {
    const idx=parseInt(msg)-1;
    if(idx>=0&&idx<(session.machines||[]).length) return await buildCustomerConfirm(session,session.machines[idx],phone);
    return 'בחר מספר מהרשימה';
  }

  if(session.step==='assign_tech') {
    const idx=parseInt(msg)-1;
    if(idx>=0&&idx<(session.techs||[]).length) {
      const tech=session.techs[idx];
      await supabase.from('tickets').update({technician_id:tech.id}).eq('id',session.ticket.id);
      const c=session.customer;
      const hist=await getHistory(c.site_code);
      const recent=await countRecent(c.site_code);
      let techMsg=`📋 קריאה חדשה!\n📍 ${c.site_name}`;
      if(c.location) techMsg+=` | ${c.location}`;
      techMsg+=`\n🏙️ ${c.city}\n🔧 ${c.machine_type}\n⚠️ ${session.faultDesc}`;
      if(c.contact_name) techMsg+=`\n👤 ${c.contact_name}`;
      if(c.contact_phone) techMsg+=` — ${c.contact_phone}`;
      techMsg+=formatHistory(hist);
      if(recent>=3) techMsg+=`\n\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
      techMsg+=`\n\nכשתסיים — כתוב: סיימתי ${c.site_name.split(' ')[0]}`;
      const groupMsg=`✅ ${c.site_name}${c.location?' | '+c.location:''} | ${c.machine_type}\n🔧 שויך ל${tech.name}`;
      session.step='idle';
      return `${groupMsg}\n\n[הודעה לטכנאי ${tech.name}]\n${techMsg}`;
    }
    return 'בחר מספר מהרשימה';
  }

  if(session.step==='select_close_ticket') {
    const idx=parseInt(msg)-1;
    if(idx>=0&&idx<(session.openTickets||[]).length) {
      session.ticketId=session.openTickets[idx].id;
      session.siteCode=session.openTickets[idx].customers?.site_code;
      session.actions=[];
      session.parts=[];
      session.step='closing_action';
      return ACTION_MENU;
    }
    return 'בחר מספר מהרשימה';
  }

  if(session.step==='closing_action') {
    if(ACTIONS[msg]) {
      if(msg==='4'){session.step='closing_part';return PART_MENU;}
      session.actions=[ACTIONS[msg]];
      session.step='closing_more';
      return MORE_MENU;
    }
    return ACTION_MENU;
  }

  if(session.step==='closing_part') {
    if(PARTS[msg]) {
      session.actions.push('החלפת חלק');
      session.parts.push(PARTS[msg]);
      session.step='closing_more';
      return MORE_MENU;
    }
    return PART_MENU;
  }

  if(session.step==='closing_more') {
    if(msg==='6') {
      const ticket=await closeTicket(session.ticketId,session.actions,session.parts||[]);
      const siteCode=ticket?.customers?.site_code||session.siteCode;
      const hist3=await getHistory(siteCode,3);
      const recent=await countRecent(siteCode);
      const actText=session.actions.join(' + ');
      const partsText=session.parts?.length?` | חלקים: ${session.parts.join(', ')}`:''
      const hist3Text=hist3.map(h=>`🔧 ${(h.closed_at||'?').slice(0,10)} — ${h.actions?h.actions.join(' + '):'לא מצוין'}`).join('\n');
      let alerts='';
      if(recent>=3) alerts+=`\n⚠️ ${recent} תקלות ב-60 יום`;
      if(session.actions.includes('טיפול אבנית')&&hist3.filter(h=>h.actions?.includes('טיפול אבנית')).length>=1) alerts+='\n💧 אבנית חוזרת — שקול בדיקת פילטר/מים';
      const c=ticket?.customers;
      const groupMsg=`✅ ${c?.site_name||''}${c?.location?' | '+c.location:''} | ${c?.machine_type||''}\n🔧 ${actText}${partsText}\n\n📜 3 תקלות אחרונות:\n${hist3Text||'אין היסטוריה'}${alerts}`;
      session.step='idle';
      return groupMsg;
    }
    if(msg==='4'){session.step='closing_part';return PART_MENU;}
    if(ACTIONS[msg]&&!session.actions.includes(ACTIONS[msg])) session.actions.push(ACTIONS[msg]);
    return MORE_MENU;
  }

  return null;
}

app.post('/webhook', async (req, res) => {
  try {
    const from=req.body.From;
    const body=req.body.Body;
    console.log(`📨 ${from}: ${body}`);
    const reply=await handleMessage(from,body);
    if(reply) {
      const twiml=new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type('text/xml');
      res.send(twiml.toString());
    } else {
      res.sendStatus(200);
    }
  } catch(err) {
    console.error('שגיאה:',err);
    res.sendStatus(500);
  }
});

app.get('/',(req,res)=>res.send('מאיירס בוט — פעיל ✅'));

const PORT=process.env.PORT||8080;
app.listen(PORT,'0.0.0.0',()=>console.log(`בוט פועל על פורט ${PORT}`));
