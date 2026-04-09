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

// מצב שיחה פר משתמש
const sessions = {};

// שלח הודעה
async function sendMessage(to, body) {
  await twilioClient.messages.create({
    from: TWILIO_NUMBER,
    to: `whatsapp:${to}`,
    body
  });
}

// חיפוש לקוח לפי שם חופשי
async function searchCustomer(query) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .ilike('site_name', `%${query}%`)
    .limit(5);
  return data || [];
}

// פתיחת תקלה
async function openTicket(siteCode, description, openedBy) {
  const ticketNumber = `KL-${Date.now().toString().slice(-6)}`;
  const { data } = await supabase.from('tickets').insert({
    ticket_number: ticketNumber,
    site_code: siteCode,
    description,
    opened_by: openedBy,
    status: 'open'
  }).select().single();
  return data;
}

// קבלת היסטוריה
async function getHistory(siteCode) {
  const { data } = await supabase
    .from('tickets')
    .select('*')
    .eq('site_code', siteCode)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(2);
  return data || [];
}

// טכנאים
async function getTechnicians() {
  const { data } = await supabase
    .from('technicians')
    .select('*')
    .eq('role', 'field')
    .eq('is_active', true);
  return data || [];
}

// סגירת תקלה
async function closeTicket(ticketId, actions, parts, notes) {
  const actionsStr = actions.join(' + ');
  const { data } = await supabase
    .from('tickets')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      actions,
      parts,
      notes,
    })
    .eq('id', ticketId)
    .select('*, customers(site_name, city, machine_type)')
    .single();
  return data;
}

// עיבוד הודעה נכנסת
async function handleMessage(from, body) {
  const phone = from.replace('whatsapp:', '');
  const msg = body.trim();
  
  if (!sessions[phone]) sessions[phone] = { step: 'idle' };
  const session = sessions[phone];

  // ===== IDLE - פתיחת תקלה =====
  if (session.step === 'idle') {
    // זיהוי פתיחת תקלה
    const faultWords = ['תקלה', 'לא מושך', 'לא מקציף', 'לא עובד', 'לא נדלק', 'לא יוצא', 'לא פועל', 'להחליף'];
    const isFault = faultWords.some(w => msg.includes(w));

    // זיהוי סגירה
    if (msg.startsWith('סיימתי')) {
      const customerName = msg.replace('סיימתי', '').trim();
      // מצא תקלה פתוחה
      const { data: openTickets } = await supabase
        .from('tickets')
        .select('*, customers(site_name)')
        .eq('status', 'open')
        .ilike('customers.site_name', `%${customerName}%`);
      
      if (!openTickets || openTickets.length === 0) {
        return `לא מצאתי תקלה פתוחה עבור "${customerName}"`;
      }
      
      if (openTickets.length === 1) {
        session.step = 'closing_action';
        session.ticketId = openTickets[0].id;
        session.actions = [];
        session.parts = [];
        return `מה עשית?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה`;
      }
      
      session.step = 'select_open_ticket';
      session.openTickets = openTickets;
      const list = openTickets.map((t, i) => `${i+1}️⃣ ${t.customers?.site_name}`).join('\n');
      return `איזו תקלה לסגור?\n${list}`;
    }

    if (isFault) {
      // חלץ שם לקוח
      let customerQuery = msg;
      faultWords.forEach(w => { customerQuery = customerQuery.replace(w, ''); });
      customerQuery = customerQuery.trim();
      
      if (customerQuery.length < 2) {
        return 'מה שם הלקוח?';
      }
      
      const customers = await searchCustomer(customerQuery);
      
      if (customers.length === 0) {
        return `לא מצאתי לקוח בשם "${customerQuery}" — בדוק את השם ונסה שוב.`;
      }
      
      if (customers.length === 1) {
        session.step = 'confirm_customer';
        session.customer = customers[0];
        session.faultDesc = msg;
        const hist = await getHistory(customers[0].site_code);
        const histText = hist.length > 0 
          ? `\n\n📜 2 תקלות אחרונות:\n${hist.map(h => `🔧 ${h.closed_at?.slice(0,10)} — ${h.actions?.join(', ') || 'לא מצוין'}`).join('\n')}`
          : '';
        return `✅ מצאתי:\n📍 ${customers[0].site_name}\n🏙️ ${customers[0].city}${customers[0].location ? ' | ' + customers[0].location : ''}\n🔧 ${customers[0].machine_type}${histText}\n\nנכון? 1️⃣ כן | 2️⃣ לא`;
      }
      
      session.step = 'select_customer';
      session.customers = customers;
      session.faultDesc = msg;
      const list = customers.map((c, i) => `${i+1}️⃣ ${c.site_name} — ${c.city}${c.location ? ' | ' + c.location : ''}`).join('\n');
      return `מצאתי כמה תוצאות:\n${list}`;
    }

    return null; // לא רלוונטי
  }

  // ===== בחירת לקוח =====
  if (session.step === 'select_customer') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < session.customers.length) {
      session.customer = session.customers[idx];
      session.step = 'confirm_customer';
      const hist = await getHistory(session.customer.site_code);
      const histText = hist.length > 0
        ? `\n\n📜 2 תקלות אחרונות:\n${hist.map(h => `🔧 ${h.closed_at?.slice(0,10)} — ${h.actions?.join(', ') || 'לא מצוין'}`).join('\n')}`
        : '';
      return `✅ ${session.customer.site_name}\n🏙️ ${session.customer.city}${session.customer.location ? ' | ' + session.customer.location : ''}\n🔧 ${session.customer.machine_type}${histText}\n\nנכון? 1️⃣ כן | 2️⃣ לא`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== אישור לקוח =====
  if (session.step === 'confirm_customer') {
    if (msg === '1' || msg.includes('כן')) {
      // פתח תקלה
      const ticket = await openTicket(session.customer.site_code, session.faultDesc, phone);
      session.ticket = ticket;
      session.step = 'assign_tech';
      
      const techs = await getTechnicians();
      session.techs = techs;
      const list = techs.map((t, i) => `${i+1}️⃣ ${t.name}`).join('\n');
      
      // היסטוריה לשיוך
      const hist = await getHistory(session.customer.site_code);
      const prevTech = hist.length > 0 ? hist[0].technician_id : null;
      
      return `✅ תקלה נרשמה — ${ticket.ticket_number}\n\nלאיזה טכנאי לשייך?\n${list}`;
    }
    if (msg === '2' || msg.includes('לא')) {
      session.step = 'idle';
      return 'בסדר — חפש שוב';
    }
  }

  // ===== שיוך טכנאי =====
  if (session.step === 'assign_tech') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < session.techs.length) {
      const tech = session.techs[idx];
      // עדכן תקלה עם טכנאי
      await supabase.from('tickets').update({ technician_id: tech.id }).eq('id', session.ticket.id);
      
      session.step = 'idle';
      const c = session.customer;
      
      // הכנת הודעה לטכנאי
      const hist = await getHistory(c.site_code);
      const histText = hist.length > 0
        ? `\n\n📜 היסטוריה:\n${hist.map(h => `🔧 ${h.closed_at?.slice(0,10)} — ${h.actions?.join(', ') || 'לא מצוין'}`).join('\n')}`
        : '';
      
      const techMsg = `📋 קריאה חדשה!\n📍 ${c.site_name}\n🏙️ ${c.city}${c.location ? ' | ' + c.location : ''}\n🔧 ${c.machine_type}\n⚠️ ${session.faultDesc}${c.contact_name ? '\n👤 ' + c.contact_name : ''}${c.contact_phone ? ' — ' + c.contact_phone : ''}${histText}\n\nכשתסיים — כתוב: סיימתי ${c.site_name.split(' ')[0]}`;
      
      return `✅ שויך ל${tech.name}\n\n*עדכון בקבוצה:*\n✅ ${c.site_name} | ${c.machine_type}\n🔧 שויך ל${tech.name}\n⏰ ${new Date().toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'})}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת תקלה לסגירה =====
  if (session.step === 'select_open_ticket') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < session.openTickets.length) {
      session.ticketId = session.openTickets[idx].id;
      session.step = 'closing_action';
      session.actions = [];
      session.parts = [];
      return `מה עשית?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה`;
    }
  }

  // ===== פעולת סגירה =====
  if (session.step === 'closing_action') {
    const actions = {
      '1': 'טיפול אבנית',
      '2': 'ניקיון מערכת הקצפה',
      '3': 'טיפול כדורית — יחידת חליטה',
      '4': 'החלפת חלק',
      '5': 'החלפת מכונה'
    };
    
    if (actions[msg]) {
      if (msg === '4') {
        session.step = 'closing_part';
        session.pendingAction = actions[msg];
        return `איזה חלק?\n1️⃣ נשם\n2️⃣ ברז חשמלי\n3️⃣ קפוצינטור\n4️⃣ יחידת חליטה\n5️⃣ טרמובלוק (דוד)`;
      }
      session.actions.push(actions[msg]);
      session.step = 'closing_more';
      return `עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה`;
    }
  }

  // ===== בחירת חלק =====
  if (session.step === 'closing_part') {
    const parts = { '1': 'נשם', '2': 'ברז חשמלי', '3': 'קפוצינטור', '4': 'יחידת חליטה', '5': 'טרמובלוק' };
    if (parts[msg]) {
      session.actions.push(session.pendingAction);
      session.parts.push(parts[msg]);
      session.step = 'closing_more';
      return `עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה`;
    }
  }

  // ===== עוד פעולה? =====
  if (session.step === 'closing_more') {
    const actions = {
      '1': 'טיפול אבנית', '2': 'ניקיון מערכת הקצפה',
      '3': 'טיפול כדורית', '4': 'החלפת חלק', '5': 'החלפת מכונה'
    };
    
    if (msg === '6') {
      // סגור תקלה
      const ticket = await closeTicket(session.ticketId, session.actions, session.parts, '');
      session.step = 'idle';
      
      // קבל 3 תקלות אחרונות
      const { data: hist } = await supabase
        .from('tickets')
        .select('*')
        .eq('site_code', ticket.site_code)
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(3);
      
      const histText = hist?.map(h => `🔧 ${h.closed_at?.slice(0,10)} — ${h.actions?.join(' + ') || 'לא מצוין'}`).join('\n') || '';
      const actionsText = session.actions.join(' + ');
      const partsText = session.parts.length > 0 ? ` | חלקים: ${session.parts.join(', ')}` : '';
      
      return `✅ ${ticket.customers?.site_name} | ${ticket.customers?.machine_type}\n🔧 ${actionsText}${partsText}\n\n📜 3 תקלות אחרונות:\n${histText}`;
    }
    
    if (actions[msg]) {
      if (msg === '4') {
        session.step = 'closing_part';
        session.pendingAction = actions[msg];
        return `איזה חלק?\n1️⃣ נשם\n2️⃣ ברז חשמלי\n3️⃣ קפוצינטור\n4️⃣ יחידת חליטה\n5️⃣ טרמובלוק (דוד)`;
      }
      session.actions.push(actions[msg]);
      return `עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה`;
    }
  }

  return null;
}

// Webhook
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
  } catch (err) {
    console.error('שגיאה:', err);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('מאיירס בוט — פעיל ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`בוט פועל על פורט ${PORT}`));
