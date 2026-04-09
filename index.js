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

// ===== תפריטים =====
const ACTION_MENU = 'מה עשית?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה';
const MORE_MENU = 'עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה';
const PART_MENU = 'איזה חלק?\n1️⃣ נשם\n2️⃣ ברז חשמלי\n3️⃣ קפוצינטור\n4️⃣ יחידת חליטה\n5️⃣ טרמובלוק (דוד)';

const ACTIONS = {'1':'טיפול אבנית','2':'ניקיון מערכת הקצפה','3':'טיפול כדורית — יחידת חליטה','4':'החלפת חלק','5':'החלפת מכונה'};
const PARTS = {'1':'נשם','2':'ברז חשמלי','3':'קפוצינטור','4':'יחידת חליטה','5':'טרמובלוק (דוד)'};
const FAULT_WORDS = ['תקלה','לא מושך','לא מקציף','לא עובד','לא נדלק','לא יוצא','לא פועל','להחליף','לא מחמם'];
const STOP_WORDS = new Set(['לא','של','את','עם','על','אל','כן','בלי','רק','תקלה','מושך','מקציף','עובד','נדלק','יוצא','פועל','מחמם']);

const sessions = {};

// ===== DB =====
async function searchCustomers(query) {
  // query = "שם_לקוח עיר" — מחפש לפי שם ומצמצם לפי עיר
  const words = query.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  if (!words.length) return [];

  // נסה את כל המילים יחד קודם
  const fullStr = words.join(' ');
  const {data: full} = await supabase.from('customers').select('*').ilike('site_name','%'+fullStr+'%').eq('is_active',true).limit(8);
  if (full && full.length > 0) return full;

  // חפש לפי כל מילה בנפרד ומצא תוצאות משותפות
  const results = [];
  for (const word of words) {
    const {data} = await supabase.from('customers').select('*').ilike('site_name','%'+word+'%').eq('is_active',true).limit(20);
    results.push(new Map((data||[]).map(c => [c.site_code, c])));
  }

  // מצא לקוחות שמופיעים בכל החיפושים
  if (results.length > 1) {
    let intersection = results[0];
    for (let i = 1; i < results.length; i++) {
      for (const key of intersection.keys()) {
        if (!results[i].has(key)) intersection.delete(key);
      }
    }
    if (intersection.size > 0) return Array.from(intersection.values()).slice(0,8);
  }

  // אחרת — תוצאות של המילה הראשונה (שם הלקוח)
  if (results[0]?.size > 0) {
    // נסה לצמצם לפי מילה שנייה (עיר)
    if (words.length > 1 && results[1]?.size > 0) {
      const byCity = Array.from(results[0].values()).filter(c => 
        words.slice(1).some(w => c.city?.includes(w) || c.site_name?.includes(w))
      );
      if (byCity.length > 0) return byCity.slice(0,8);
    }
    return Array.from(results[0].values()).slice(0,8);
  }

  return [];
}

async function getCustomerMachines(siteName) {
  // כל המכונות של אותו לקוח (לפי שם דומה)
  const baseName = siteName.split('(')[0].split('-')[0].trim().slice(0,15);
  const {data} = await supabase.from('customers').select('*').ilike('site_name','%'+baseName+'%').eq('is_active',true).limit(10);
  return data || [];
}

async function getHistory(siteCode, limit=2) {
  const {data} = await supabase.from('tickets').select('closed_at,actions,technician_id').eq('site_code',siteCode).eq('status','closed').order('closed_at',{ascending:false}).limit(limit);
  return data||[];
}

async function countRecent(siteCode, days=60) {
  const since = new Date(Date.now()-days*86400000).toISOString();
  const {count} = await supabase.from('tickets').select('*',{count:'exact',head:true}).eq('site_code',siteCode).gte('opened_at',since);
  return count||0;
}

async function getTechnicians() {
  const {data} = await supabase.from('technicians').select('*').in('role',['field']).eq('is_active',true);
  return data||[];
}

async function getPrevTech(siteCode) {
  const hist = await getHistory(siteCode, 3);
  if (!hist.length) return null;
  const withTech = hist.filter(h => h.technician_id);
  if (!withTech.length) return null;
  const {data} = await supabase.from('technicians').select('name').eq('id', withTech[0].technician_id).single();
  return data?.name || null;
}

async function openTicket(siteCode, machineLocation, description, openedBy) {
  const ticketNumber = `KL-${Date.now().toString().slice(-6)}`;
  const {data} = await supabase.from('tickets').insert({
    ticket_number: ticketNumber, site_code: siteCode,
    machine_location: machineLocation, description,
    opened_by: openedBy, status: 'open'
  }).select().single();
  return data;
}

async function assignTechnician(ticketId, techName) {
  const {data: tech} = await supabase.from('technicians').select('id').eq('name', techName).single();
  if (tech) await supabase.from('tickets').update({technician_id: tech.id}).eq('id', ticketId);
}

async function closeTicket(ticketId, actions, parts) {
  const {data} = await supabase.from('tickets')
    .update({status:'closed', closed_at:new Date().toISOString(), actions, parts})
    .eq('id', ticketId)
    .select('*,customers(site_name,city,machine_type,location,site_code,contact_name,contact_phone)')
    .single();
  return data;
}

// ===== FORMATTERS =====
function fmtHistory(hist) {
  if (!hist.length) return '';
  return '\n📜 היסטוריה אחרונה:\n' + hist.map(h =>
    `🔧 ${(h.closed_at||'?').slice(0,10)} — ${h.actions ? h.actions.join(' + ') : 'לא מצוין'}`
  ).join('\n');
}

function fmtDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function extractClientName(msg) {
  let t = msg;
  FAULT_WORDS.forEach(w => { t = t.split(w).join(' '); });
  return t.replace(/[^\u05d0-\u05eaA-Za-z0-9 ]/g,' ').replace(/ +/g,' ').trim();
}

// ===== MAIN HANDLER =====
async function handleMessage(from, body) {
  const phone = from.replace('whatsapp:','');
  const msg = body.trim();
  if (!sessions[phone]) sessions[phone] = {step:'idle'};
  const s = sessions[phone];

  // ===== IDLE =====
  if (s.step === 'idle') {

    // סגירה: "סיימתי [לקוח] [פעולה]"
    if (msg.startsWith('סיימתי')) {
      const rest = msg.replace('סיימתי','').trim();
      const words = rest.split(/\s+/);
      const clientWord = words[0] || '';

      const {data: openTickets} = await supabase.from('tickets')
        .select('*,customers(site_name,site_code,machine_type,location)')
        .eq('status','open').order('opened_at',{ascending:false});

      const matched = (openTickets||[]).filter(t =>
        t.customers?.site_name?.includes(clientWord)
      );

      if (!matched.length) return `לא מצאתי תקלה פתוחה עבור "${clientWord}"`;

      // זיהוי פעולה מהטקסט
      const restText = words.slice(1).join(' ');
      let detectedAction = null;
      if (restText.includes('אבנית')) detectedAction = 'טיפול אבנית';
      else if (restText.includes('קצפ') || restText.includes('הקצפה')) detectedAction = 'ניקיון מערכת הקצפה';
      else if (restText.includes('כדורית')) detectedAction = 'טיפול כדורית — יחידת חליטה';
      else if (restText.includes('מכונה')) detectedAction = 'החלפת מכונה';
      else if (restText.includes('נשם')) { detectedAction = 'החלפת חלק'; s.closingPart = 'נשם'; }
      else if (restText.includes('ברז')) { detectedAction = 'החלפת חלק'; s.closingPart = 'ברז חשמלי'; }
      else if (restText.includes('קפוצינטור')) { detectedAction = 'החלפת חלק'; s.closingPart = 'קפוצינטור'; }

      if (matched.length === 1) {
        s.ticketId = matched[0].id;
        s.siteCode = matched[0].customers?.site_code;
        s.closingMachine = matched[0].customers?.location || matched[0].customers?.machine_type;
        s.closingSiteName = matched[0].customers?.site_name;
        s.actions = detectedAction ? [detectedAction] : [];
        s.parts = s.closingPart ? [s.closingPart] : [];
        s.step = 'closing_more';
        return MORE_MENU;
      }

      // כמה תקלות פתוחות — תן לבחור
      s.step = 'select_close_ticket';
      s.openTickets = matched;
      return 'איזו תקלה לסגור?\n' + matched.map((t,i) =>
        `${i+1}️⃣ ${t.customers?.site_name}${t.customers?.location?' | '+t.customers.location:''}`
      ).join('\n');
    }

    // פתיחת תקלה
    const isFault = FAULT_WORDS.some(w => msg.includes(w));
    if (isFault) {
      const clientName = extractClientName(msg);
      if (clientName.length < 2) return 'מה שם הלקוח?';

      const customers = await searchCustomers(clientName);
      if (!customers.length) return `לא מצאתי לקוח בשם "${clientName}" — בדוק את השם ונסה שוב.`;

      s.faultDesc = msg;

      // עדכון קבוצה
      const groupUpdate = `✅ תקלה נרשמה — ${customers[0].site_name}\n⏳ ממתין לפרטי מכונה`;

      if (customers.length === 1) {
        return await handleOneCustomer(s, customers[0], phone, groupUpdate);
      }

      s.step = 'select_customer';
      s.customers = customers;
      s.groupUpdate = groupUpdate;
      return `מצאתי כמה תוצאות:\n` +
        customers.map((c,i) => `${i+1}️⃣ ${c.site_name} — ${c.city}${c.location?' | '+c.location:''}`).join('\n');
    }

    // סיכום יומי
    if (msg === 'סיכום יומי') {
      const techs = await getTechnicians();
      const {data: openAll} = await supabase.from('tickets')
        .select('*,customers(site_name,machine_type)')
        .eq('status','open').order('opened_at',{ascending:false});

      let summary = `📋 סיכום יומי — ${new Date().toLocaleDateString('he-IL')}\n\n`;
      for (const tech of techs) {
        const myTickets = (openAll||[]).filter(t => t.technician_id === tech.id);
        if (!myTickets.length) continue;
        summary += `*${tech.name}* — ${myTickets.length} פתוחות\n`;
        myTickets.forEach(t => {
          summary += `• ${t.customers?.site_name||'?'} | ${t.description||'?'} | ${t.customers?.machine_type||''}\n`;
          summary += `  ⏰ פתוח מ-${fmtDate(t.opened_at)}\n`;
        });
        summary += '\n';
      }
      summary += 'לשלוח לכולם? 1️⃣ כן | 2️⃣ עריכה';
      s.step = 'daily_summary_confirm';
      s.summaryTechs = techs;
      s.summaryTickets = openAll;
      return summary;
    }

    return null;
  }

  // ===== בחירת לקוח =====
  if (s.step === 'select_customer') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.customers||[]).length) {
      return await handleOneCustomer(s, s.customers[idx], phone, s.groupUpdate);
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת מכונה =====
  if (s.step === 'select_machine') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.machines||[]).length) {
      const machine = s.machines[idx];
      return await buildShiuach(s, machine, phone);
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== שיוך טכנאי (אורי בוחר) =====
  if (s.step === 'assign_tech') {
    const idx = parseInt(msg) - 1;
    const techs = s.techs || [];

    if (msg === '2' || msg.toLowerCase() === 'אחר') {
      // הצג רשימת כל טכנאים
      s.step = 'assign_tech_pick';
      return 'בחר טכנאי:\n' + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');
    }

    if (msg === '1') {
      // שייך לטכנאי המומלץ
      const techName = s.suggestedTech;
      return await finishAssign(s, techName, phone);
    }
    return `לשייך ל${s.suggestedTech}?\n1️⃣ כן | 2️⃣ טכנאי אחר`;
  }

  // ===== בחירת טכנאי ידנית =====
  if (s.step === 'assign_tech_pick') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      return await finishAssign(s, s.techs[idx].name, phone);
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת תקלה לסגירה =====
  if (s.step === 'select_close_ticket') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.openTickets||[]).length) {
      const t = s.openTickets[idx];
      s.ticketId = t.id;
      s.siteCode = t.customers?.site_code;
      s.closingMachine = t.customers?.location || t.customers?.machine_type;
      s.closingSiteName = t.customers?.site_name;
      s.actions = [];
      s.parts = [];
      s.step = 'closing_more';
      return MORE_MENU;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== פעולת סגירה ראשונה =====
  if (s.step === 'closing_action') {
    if (ACTIONS[msg]) {
      if (msg === '4') { s.step = 'closing_part'; return PART_MENU; }
      s.actions = [ACTIONS[msg]];
      s.step = 'closing_more';
      return MORE_MENU;
    }
    return ACTION_MENU;
  }

  // ===== בחירת חלק =====
  if (s.step === 'closing_part') {
    if (PARTS[msg]) {
      s.actions.push('החלפת חלק');
      s.parts.push(PARTS[msg]);
      s.step = 'closing_more';
      return MORE_MENU;
    }
    return PART_MENU;
  }

  // ===== עוד פעולה? =====
  if (s.step === 'closing_more') {
    if (msg === '6') {
      return await doCloseTicket(s);
    }
    if (msg === '4') { s.step = 'closing_part'; return PART_MENU; }
    if (ACTIONS[msg] && !s.actions.includes(ACTIONS[msg])) {
      s.actions.push(ACTIONS[msg]);
    }
    return MORE_MENU;
  }

  // ===== אישור סיכום יומי =====
  if (s.step === 'daily_summary_confirm') {
    if (msg === '1') {
      s.step = 'idle';
      return '✅ סיכום יומי נשלח לכל הטכנאים';
    }
    return 'עריכת סיכום יומי — בקרוב';
  }

  return null;
}

// ===== HELPERS =====

async function handleOneCustomer(s, customer, phone, groupUpdate) {
  // בדוק כמה מכונות לאותו לקוח
  const machines = await getCustomerMachines(customer.site_name);

  if (machines.length > 1) {
    s.step = 'select_machine';
    s.machines = machines;
    s.faultCustomer = customer;
    const list = machines.map((m,i) =>
      `${i+1}️⃣ ${m.location || 'לא מצוין'} | ${m.machine_type}`
    ).join('\n');
    return `${groupUpdate}\n\n📲 פרטי אליך:\n` +
      `יש ${machines.length} מכונות ב${customer.site_name} — איזו?\n${list}`;
  }

  return await buildShiuach(s, customer, phone, groupUpdate);
}

async function buildShiuach(s, machine, phone, groupUpdate='') {
  s.selectedMachine = machine;
  const hist = await getHistory(machine.site_code);
  const recent = await countRecent(machine.site_code);
  const prevTech = await getPrevTech(machine.site_code);
  const techs = await getTechnicians();

  // פתח תקלה
  const ticket = await openTicket(machine.site_code, machine.location, s.faultDesc, phone);
  s.ticket = ticket;
  s.techs = techs;
  s.suggestedTech = prevTech || techs[0]?.name;
  s.step = 'assign_tech';

  // הודעה לאורי
  let oriMsg = `📋 תקלה חדשה\n📍 ${machine.site_name}`;
  if (machine.location) oriMsg += ` — ${machine.location}`;
  oriMsg += `\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) oriMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) oriMsg += ` ${machine.contact_phone}`;
  oriMsg += fmtHistory(hist);
  if (recent >= 3) oriMsg += `\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  oriMsg += `\n\n🔧 טיפל בעבר: ${prevTech || 'לא ידוע'}`;
  oriMsg += `\n\nלשייך ל${s.suggestedTech}?\n1️⃣ כן | 2️⃣ טכנאי אחר`;

  return `${groupUpdate ? groupUpdate + '\n\n' : ''}📲 פרטי לאורי:\n${oriMsg}`;
}

async function finishAssign(s, techName, phone) {
  const machine = s.selectedMachine;
  if (s.ticket) await assignTechnician(s.ticket.id, techName);

  const hist = await getHistory(machine.site_code);
  const recent = await countRecent(machine.site_code);

  // הודעה לטכנאי
  let techMsg = `📋 קריאה חדשה!\n📍 ${machine.site_name}`;
  if (machine.location) techMsg += ` | ${machine.location}`;
  techMsg += `\n🏙️ ${machine.city}\n🔧 ${machine.machine_type}\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) techMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) techMsg += ` — ${machine.contact_phone}`;
  techMsg += fmtHistory(hist);
  if (recent >= 3) techMsg += `\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  techMsg += `\n\nכשתסיים — כתוב: סיימתי ${machine.site_name.split(' ')[0]}`;

  // עדכון קבוצה
  const groupMsg = `✅ ${machine.site_name}${machine.location?' | '+machine.location:''} | ${machine.machine_type}\n🔧 שויך ל${techName}`;

  s.step = 'idle';
  return `📲 פרטי לאורי:\n✅ שויך ל${techName}\n\n📲 פרטי ל${techName}:\n${techMsg}\n\n📲 קבוצה:\n${groupMsg}`;
}

async function doCloseTicket(s) {
  const ticket = await closeTicket(s.ticketId, s.actions, s.parts||[]);
  const siteCode = ticket?.customers?.site_code || s.siteCode;
  const hist3 = await getHistory(siteCode, 3);
  const recent = await countRecent(siteCode);

  const c = ticket?.customers;
  const actText = s.actions.join(' + ');
  const partsText = s.parts?.length ? ` | חלקים: ${s.parts.join(', ')}` : '';

  // 3 תקלות אחרונות
  const hist3Text = hist3.map(h =>
    `🔧 ${(h.closed_at||'?').slice(0,10)} — ${h.actions ? h.actions.join(' + ') : 'לא מצוין'}`
  ).join('\n');

  // התראות
  let alerts = '';
  if (recent >= 3) alerts += `\n⚠️ ${recent} תקלות ב-60 יום`;
  const abnitCount = hist3.filter(h => h.actions?.includes('טיפול אבנית')).length;
  if (s.actions.includes('טיפול אבנית') && abnitCount >= 1) {
    alerts += '\n💧 אבנית חוזרת — שקול בדיקת מים או פילטר';
  }

  // עדכון קבוצה
  const groupMsg = `✅ ${c?.site_name||''} — ${s.closingMachine||c?.location||c?.machine_type||''} | ${c?.machine_type||''}\n🔧 ${actText}${partsText}\n\n📜 3 תקלות אחרונות:\n${hist3Text||'אין היסטוריה'}${alerts}`;

  s.step = 'idle';
  return `📲 קבוצה:\n${groupMsg}`;
}

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;
    console.log(`📨 ${from}: ${body}`);
    const reply = await handleMessage(from, body);
    if (reply) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type('text/xml');
      res.send(twiml.toString());
    } else {
      res.sendStatus(200);
    }
  } catch(err) {
    console.error('שגיאה:', err);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('מאיירס בוט — פעיל ✅'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`בוט פועל על פורט ${PORT}`));
