require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = 'whatsapp:+972584820015';

// ===== תפריטים =====
const ACTION_MENU = 'מה עשית?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה';
const MORE_MENU = 'עשית משהו נוסף?\n1️⃣ טיפול אבנית\n2️⃣ ניקיון מערכת הקצפה\n3️⃣ טיפול כדורית — יחידת חליטה\n4️⃣ החלפת חלק\n5️⃣ החלפת מכונה\n6️⃣ לא — סגור תקלה';
const PART_MENU = 'איזה חלק?\n1️⃣ נשם\n2️⃣ ברז חשמלי\n3️⃣ קפוצינטור\n4️⃣ יחידת חליטה\n5️⃣ טרמובלוק (דוד)';

const ACTIONS = {'1':'טיפול אבנית','2':'ניקיון מערכת הקצפה','3':'טיפול כדורית — יחידת חליטה','4':'החלפת חלק','5':'החלפת מכונה'};
const PARTS = {'1':'נשם','2':'ברז חשמלי','3':'קפוצינטור','4':'יחידת חליטה','5':'טרמובלוק (דוד)'};
const FAULT_WORDS = ['תקלה','לא מושך','לא מקציף','לא עובד','לא נדלק','לא יוצא','לא פועל','להחליף','לא מחמם'];
const STOP_WORDS = new Set(['לא','של','את','עם','על','אל','כן','בלי','רק','תקלה','מושך','מקציף','עובד','נדלק','יוצא','פועל','מחמם']);

// רשימת ערים ישראליות
const ISRAEL_CITIES = new Set([
  'תל אביב','ירושלים','חיפה','ראשון לציון','פתח תקווה','אשדוד','נתניה','באר שבע',
  'בני ברק','חולון','רמת גן','אשקלון','רחובות','בת ים','בית שמש','קריית גת',
  'הרצליה','חדרה','מודיעין','לוד','רמלה','עכו','אילת','נצרת','עפולה',
  'ראש העין','קריית אתא','קריית ביאליק','קריית מוצקין','קריית ים','קריית שמונה',
  'הוד השרון','נס ציונה','טבריה','צפת','כפר סבא','רעננה','הרצליה','רמת השרון',
  'גבעתיים','רמת גן','בני ברק','קריית אונו','גיבתיים','אור יהודה','קריית מלאכי',
  'דימונה','ערד','מצפה רמון','נהריה','טירת כרמל','קריית חיים','קריית שמואל',
  'יוקנעם','זכרון יעקב','קיסריה','עמק יזרעאל','עמק חפר','שרון','שפלה',
  'אבן יהודה','כפר יונה','נתיבות','שדרות','אופקים','ירוחם','מגדל העמק',
  'נשר','טמרה','שפרעם','סכנין','אום אל פחם','בית שאן','בית שמש',
  'מעלה אדומים','ביתר עילית','אלעד','מודיעין עילית','ביתר','רכסים',
  'פרדס חנה','בנימינה','זיכרון','גבעת שמואל','גני תקווה','אור עקיבא',
  'חריש','נוף הגליל','מגדל העמק','קריית טבעון','טירה','קלנסווה',
  'יבנה','גדרה','מזכרת בתיה','באר יעקב','נס ציונה','גן רוה',
  'פתחיה','שוהם','ראש העין','כפר קאסם','טייבה','כפר יאסיף',
  'בארי','שדות נגב','אשכול','מרחבים','בני שמעון'
]);

function extractCityFromMsg(msg) {
  // חפש עיר של שתי מילים קודם
  const twoCities = Array.from(ISRAEL_CITIES).filter(c => c.includes(' '));
  for (const city of twoCities) {
    if (msg.includes(city)) return city;
  }
  // עיר של מילה אחת
  const oneCities = Array.from(ISRAEL_CITIES).filter(c => !c.includes(' '));
  const words = msg.split(/\s+/);
  for (const word of words) {
    if (oneCities.includes(word)) return word;
  }
  return '';
}


const sessions = {};

// ===== DB =====
async function searchCustomers(clientName, cityName) {
  if (!clientName || clientName.length < 2) return [];

  // שלב 1: חיפוש ישיר ilike
  const {data} = await supabase.from('customers').select('*')
    .ilike('site_name','%'+clientName+'%').eq('is_active',true).limit(20);

  let results = data || [];

  // שלב 2: אם לא נמצא — חפש לפי כל מילה בנפרד
  if (results.length === 0) {
    const words = clientName.split(/\s+/).filter(w => w.length > 2);
    const seen = new Map();
    for (const word of words) {
      const {data: partial} = await supabase.from('customers').select('*')
        .ilike('site_name','%'+word+'%').eq('is_active',true).limit(10);
      (partial||[]).forEach(c => seen.set(c.site_code, c));
    }
    results = Array.from(seen.values());
  }

  // שלב 3: אם עדיין לא נמצא — חיפוש similarity עם pg_trgm
  if (results.length === 0) {
    const {data: similar} = await supabase.rpc('search_customers_fuzzy', {
      search_term: clientName,
      threshold: 0.2
    });
    results = similar || [];
  }

  if (!results.length) return [];

  // סנן לפי עיר אם יש
  if (cityName && cityName.length > 1) {
    const filtered = results.filter(c => 
      c.city?.includes(cityName) || c.site_name?.includes(cityName)
    );
    if (filtered.length > 0) return filtered.slice(0,8);
  }

  return results.slice(0,8);
}

async function getCustomerMachines(siteName, cityName='') {
  // קודם מצא את הלקוח המדויק
  const {data: exact} = await supabase.from('customers').select('*').eq('site_name', siteName).eq('is_active',true).limit(1);
  
  if (exact && exact.length > 0 && exact[0].customer_id) {
    // מצא כל המכונות עם אותו customer_id
    let query = supabase.from('customers').select('*').eq('customer_id', exact[0].customer_id).eq('is_active',true);
    
    // אם יש עיר — סנן לפיה
    if (cityName && cityName.length > 1) {
      query = query.ilike('city', '%'+cityName+'%');
    }
    
    const {data} = await query.limit(15);
    if (data && data.length > 0) return data;
    
    // אם לא נמצא עם עיר — החזר את המכונה המקורית בלבד
    return exact;
  }
  
  return exact || [];
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

function extractClientAndCity(msg) {
  // הסר מילות תקלה
  let t = msg;
  FAULT_WORDS.forEach(w => { t = t.split(w).join(' '); });
  t = t.replace(/[^\u05d0-\u05eaA-Za-z0-9 ]/g,' ').replace(/ +/g,' ').trim();
  
  const words = t.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
  if (!words.length) return {clientName:'', cityName:''};
  
  // המילה הראשונה = שם לקוח, המילה השנייה = עיר
  const clientName = words[0];
  const cityName = words.length > 1 ? words[1] : '';
  return {clientName, cityName};
}

// ===== MAIN HANDLER =====
// ===== שליחת WhatsApp ישירה =====
async function sendWhatsApp(toPhone, message) {
  try {
    // נקה ופרמט מספר — תמיד +972XXXXXXXXX
    let num = String(toPhone).replace(/\D/g,'');
    if (num.startsWith('0')) num = '972' + num.slice(1);
    if (!num.startsWith('972')) num = '972' + num;
    const to = '+' + num;
    console.log('📤 שולח ל:', to);
    await twilioClient.messages.create({
      from: 'whatsapp:+972584820015',
      to: `whatsapp:${to}`,
      body: message
    });
    console.log('✅ נשלח ל', to);
  } catch(e) {
    console.error('❌ שגיאה בשליחה:', toPhone, e.message);
  }
}

// ===== זיהוי משתמשים לפי טלפון =====
function getUserRole(phone) {
  // phone comes as "972505771762" (already without + from whatsapp: strip)
  const num = phone.replace(/^\+/,'').replace(/^0/,'972');
  console.log('getUserRole:', phone, '->', num, '| ORI:', process.env.PHONE_ORI, '| ODED:', process.env.PHONE_ODED);
  const roles = {
    [process.env.PHONE_ORI]:      { name: 'אורי',   role: 'manager' },
    [process.env.PHONE_AVSHALOM]: { name: 'אבשלום', role: 'technician' },
    [process.env.PHONE_BENIA]:    { name: 'בניה',   role: 'technician' },
    [process.env.PHONE_SHAKED]:   { name: 'שקד',    role: 'technician' },
    [process.env.PHONE_ALEX]:     { name: 'אלכס',   role: 'lab' },
    [process.env.PHONE_GABI]:     { name: 'גבי',    role: 'installations' },
    [process.env.PHONE_DUDI]:     { name: 'דודי',   role: 'agent' },
    [process.env.PHONE_AMIR]:     { name: 'אמיר',   role: 'agent' },
    [process.env.PHONE_ODED]:     { name: 'עודד',   role: 'manager' },
  };
  return roles[num] || { name: null, role: 'unknown' };
}

async function handleMessage(from, body) {
  const phone = from.replace('whatsapp:','');
  const msg = body.trim();
  if (!sessions[phone]) sessions[phone] = {step:'idle'};
  const s = sessions[phone];
  s._phone = phone;
  const user = getUserRole(phone);
  s.userName = user.name;
  s.userRole = user.role;

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

    // פתיחת תקלה — פורמט: [שם לקוח] [עיר] תקלה [תיאור]
    const isFault = FAULT_WORDS.some(w => msg.includes(w));
    if (isFault) {
      // זהה עיר מרשימת הערים
      const cityName = extractCityFromMsg(msg);
      
      // הסר עיר ומילות תקלה — מה שנשאר = שם לקוח
      let clientText = msg;
      if (cityName) clientText = clientText.split(cityName).join(' ');
      FAULT_WORDS.forEach(w => { clientText = clientText.split(w).join(' '); });
      ['לא','של','את','עם','על','בלי','רק'].forEach(w => { clientText = clientText.split(' '+w+' ').join(' '); });
      clientText = clientText.replace(/[^\u05d0-\u05eaA-Za-z0-9 ]/g,' ').replace(/ +/g,' ').trim();
      const clientName = clientText;
      
      if (clientName.length < 2) return 'מה שם הלקוח?';
      
      let customers = await searchCustomers(clientName, cityName);
      if (!customers.length) return `לא מצאתי לקוח בשם "${clientName}"${cityName?' ב'+cityName:''} — בדוק את השם ונסה שוב.`;

      s.faultDesc = msg;
      s.cityName = cityName; // שמור עיר לסינון מכונות

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


  // ===== מעבדה — אלכס =====
  if (msg === 'מתחיל עבודה' || msg.startsWith('מתחיל עבודה')) {
    s.step = 'lab_select_machine';
    return 'איזו מכונה?\n1️⃣ M12\n2️⃣ F16\n3️⃣ F15';
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

  // ===== שיוך טכנאי לאיסוף =====
  if (s.step === 'collection_assign') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      const tech = s.techs[idx];
      const note = s.pendingCollection;
      const machines = s.collectionMachines || [];
      const qty = note.machine_quantity || 1;

      // הודעה לטכנאי
      let machineInfo = machines.length > 0
        ? '\n🔧 מכונות:\n' + machines.map((m,i) => `${i+1}️⃣ ${m.location||'לא מצוין'} | ${m.machine_type}`).join('\n')
        : '';
      
      const techMsg = `🔄 משימת איסוף!\n📍 ${note.client_name}\n🏙️ ${note.city}\n📬 ${note.address}\n🔧 לאסוף ${qty} מכונות${machineInfo}\n👤 ${note.contact_name||''} ${note.contact_phone||''}\n\nכשתסיים — צלם תעודה חתומה ושלח עם המילה: נאסף`;

      // אם יש כמה מכונות — צריך לדעת איזו/אילו
      if (machines.length > qty) {
        s.step = 'collection_select_machines';
        s.collectionTech = tech;
        s.collectionQty = qty;
        const list = machines.map((m,i) => `${i+1}️⃣ ${m.location||'לא מצוין'} | ${m.machine_type} | ${m.city}`).join('\n');
        return `✅ שויך ל${tech.name}\n\n[הודעה ל${tech.name}]\n${techMsg}\n\nיש ${machines.length} מכונות — אילו ${qty} נאספות?\n${list}\n\nבחר ${qty} מספרים (לדוגמה: 1,3)`;
      }

      // מכונה אחת או כל המכונות
      s.step = 'collection_confirm';
      s.collectionTech = tech;
      return `✅ שויך ל${tech.name}\n\n[הודעה ל${tech.name}]\n${techMsg}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת מכונות לאיסוף =====
  if (s.step === 'collection_select_machines') {
    const selected = msg.split(',').map(n => parseInt(n.trim()) - 1).filter(i => i >= 0 && i < (s.collectionMachines||[]).length);
    if (selected.length === 0) return 'בחר מספרים מהרשימה (לדוגמה: 1,3)';
    s.selectedCollectionMachines = selected.map(i => s.collectionMachines[i]);
    s.step = 'collection_confirm';
    const list = s.selectedCollectionMachines.map(m => `• ${m.location||'לא מצוין'} | ${m.machine_type}`).join('\n');
    return `✅ מכונות שנאספות:\n${list}\n\nממתין לאישור טכנאי (נאסף + תעודה)`;
  }

  // ===== שיוך טכנאי להתקנה =====
  if (s.step === 'installation_assign') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      const tech = s.techs[idx];
      const note = s.pendingNote;

      // שמור התקנה במסד
      const {data: inst} = await supabase.from('installations').insert({
        site_code: null,
        delivery_note_number: note.delivery_note_number,
        machine_type: note.machine_type,
        location: note.address,
        technician_id: tech.id,
        notes: JSON.stringify(note)
      }).select().single();

      s.installationId = inst?.id;
      s.step = 'idle';

      // הודעה לטכנאי
      const techMsg = `📦 משימת התקנה חדשה!\n📍 ${note.client_name}\n🏙️ ${note.city}\n📬 ${note.address}\n🔧 ${note.machine_type}\n👤 ${note.contact_name} — ${note.contact_phone}\n\nכשתסיים — צלם תעודה חתומה ושלח עם המילה: הותקן`;

      return `✅ שויך ל${tech.name}\n\n[הודעה ל${tech.name}]\n${techMsg}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== סגירת התקנה =====
  if (msg === 'הותקן') {
    s.step = 'installation_confirm';
    return 'שלח צילום של התעודה החתומה 📸';
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

  // ===== סגירת איסוף — טכנאי שולח "נאסף" לפתיחת תהליך =====
  if ((msg === 'נאסף' || msg.startsWith('נאסף ')) && s.step !== 'collection_photo' && s.step !== 'collection_which_machine') {
    const clientWord = msg.replace('נאסף','').trim();
    
    // אם יש מכונות בסשן — השתמש בהן
    let machines = s.collectionMachines || [];
    
    // אם אין בסשן או כתב שם לקוח — חפש במסד
    if (machines.length === 0 && clientWord.length > 1) {
      const {data} = await supabase.from('customers')
        .select('site_code, site_name, city, location, machine_type')
        .ilike('site_name', '%'+clientWord+'%')
        .eq('is_active', true)
        .limit(10);
      machines = data || [];
      s.collectionMachines = machines;
    }
    
    if (machines.length === 0) {
      return 'לא מצאתי מכונות — כתוב: נאסף [שם לקוח]';
    }
    
    if (machines.length === 1) {
      return await doCollectMachine(s, machines[0]);
    }
    
    // כמה מכונות — בחר איזו
    s.step = 'collection_which_machine';
    const list = machines.map((m,i) => `${i+1}️⃣ ${m.site_name}${m.location?' | '+m.location:''} | ${m.machine_type} | ${m.city}`).join('\n');
    return `איזו מכונה נאספה?\n${list}`;
  }

  if (s.step === 'collection_which_machine') {
    const idx = parseInt(msg) - 1;
    const machines = s.collectionMachines || [];
    if (idx >= 0 && idx < machines.length) {
      return await doCollectMachine(s, machines[idx]);
    }
    return 'בחר מספר מהרשימה';
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


  // ===== מעבדה — בחירת מכונה =====
  if (s.step === 'lab_select_machine') {
    const machines = {'1':'M12','2':'F16','3':'F15'};
    if (machines[msg]) {
      s.labMachine = machines[msg];
      s.labStart = new Date().toISOString();
      s.step = 'lab_working';
      const timeStr = new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});
      // שמור ב-DB
      supabase.from('lab_jobs').insert({
        machine_type: s.labMachine,
        started_at: s.labStart,
        technician_id: null
      }).then(() => {});
      return `🔧 כרטיס עבודה נפתח\n⏰ התחלה: ${timeStr}\nמכונה: ${s.labMachine}\n\nכשתסיים — כתוב: סיימתי`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== מעבדה — סגירה =====
  if (s.step === 'lab_working') {
    if (msg === 'סיימתי') {
      s.step = 'lab_action';
      s.actions = [];
      s.parts = [];
      return ACTION_MENU;
    }
    return `אתה עובד על ${s.labMachine}\nכשתסיים — כתוב: סיימתי`;
  }

  // ===== מעבדה — פעולה =====
  if (s.step === 'lab_action') {
    if (ACTIONS[msg]) {
      if (msg === '4') { s.step = 'lab_part'; return PART_MENU; }
      s.actions = [ACTIONS[msg]];
      s.step = 'lab_more';
      return MORE_MENU;
    }
    return ACTION_MENU;
  }

  // ===== מעבדה — חלק =====
  if (s.step === 'lab_part') {
    if (PARTS[msg]) {
      s.actions.push('החלפת חלק');
      s.parts.push(PARTS[msg]);
      s.step = 'lab_more';
      return MORE_MENU;
    }
    return PART_MENU;
  }

  // ===== מעבדה — עוד פעולה =====
  if (s.step === 'lab_more') {
    if (msg === '6') {
      // סגור עבודת מעבדה
      const endTime = new Date().toISOString();
      const actText = s.actions.join(' + ');
      const partsText = s.parts?.length ? ` | חלקים: ${s.parts.join(', ')}` : '';
      await supabase.from('lab_jobs').update({
        completed_at: endTime,
        actions: s.actions,
        parts: s.parts
      }).eq('machine_type', s.labMachine).is('completed_at', null);
      // עדכן מלאי
      if (s.parts && s.parts.length > 0) {
        for (const part of s.parts) {
          await deductInventory(part);
        }
      }
      
      s.step = 'idle';
      return `✅ עבודת מעבדה הושלמה\n🔧 ${s.labMachine} | ${actText}${partsText}`;
    }
    if (msg === '4') { s.step = 'lab_part'; return PART_MENU; }
    if (ACTIONS[msg] && !s.actions.includes(ACTIONS[msg])) s.actions.push(ACTIONS[msg]);
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
  // בדוק כמה מכונות לאותו לקוח — סנן לפי עיר אם יש
  const machines = await getCustomerMachines(customer.site_name, s.cityName || '');

  if (machines.length > 1) {
    s.step = 'select_machine';
    s.machines = machines;
    s.faultCustomer = customer;
    const list = machines.map((m,i) =>
      `${i+1}️⃣ ${m.city || ''} | ${m.location || 'לא מצוין'} | ${m.machine_type}`
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
  const ticket = await openTicket(machine.site_code, machine.location, s.faultDesc, s.userName || phone);
  s.ticket = ticket;
  s.techs = techs;
  s.suggestedTech = prevTech || techs[0]?.name;
  s.step = 'assign_tech';

  // הודעה לאורי
  let oriMsg = `📋 תקלה חדשה\n📍 ${machine.site_name}`;
  if (machine.address) oriMsg += `\n📬 ${machine.address}`;
  if (machine.city) oriMsg += `, ${machine.city}`;
  if (machine.location) oriMsg += `\n🏢 ${machine.location}`;
  oriMsg += `\n🔧 ${machine.machine_type}`;
  oriMsg += `\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) oriMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) oriMsg += ` — ${machine.contact_phone}`;
  // 2 תקלות אחרונות עם תאריכים
  if (hist && hist.length > 0) {
    oriMsg += `\n\n📜 תקלות אחרונות:`;
    hist.slice(0,2).forEach(h => {
      const date = (h.closed_at||'').slice(0,10);
      const acts = h.actions?.join(' + ') || 'לא מצוין';
      oriMsg += `\n🔧 ${date} — ${acts}`;
    });
  }
  if (recent >= 3) oriMsg += `\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  oriMsg += `\n\n🔧 טיפל בעבר: ${prevTech || 'לא ידוע'}`;
  oriMsg += `\n\nלשייך ל${s.suggestedTech}?\n1️⃣ כן | 2️⃣ טכנאי אחר`;

  // שלח לאורי ישירות ב-WhatsApp
  const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
  for (const p of oriPhones) {
    await sendWhatsApp(p, oriMsg);
  }

  // החזר לפותח רק את עדכון הקבוצה
  return groupUpdate || '✅ תקלה נרשמה';
}

async function finishAssign(s, techName, phone) {
  const machine = s.selectedMachine;
  if (s.ticket) await assignTechnician(s.ticket.id, techName);

  const hist = await getHistory(machine.site_code);
  const recent = await countRecent(machine.site_code);

  // הודעה לטכנאי
  let techMsg = `📋 קריאה חדשה!\n📍 ${machine.site_name}`;
  if (machine.address) techMsg += `\n📬 ${machine.address}`;
  if (machine.city) techMsg += `, ${machine.city}`;
  if (machine.location) techMsg += `\n🏢 ${machine.location}`;
  techMsg += `\n🔧 ${machine.machine_type}`;
  techMsg += `\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) techMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) techMsg += ` — ${machine.contact_phone}`;
  // 2 תקלות אחרונות עם תאריכים
  if (hist && hist.length > 0) {
    techMsg += `\n\n📜 תקלות אחרונות:`;
    hist.slice(0,2).forEach(h => {
      const date = (h.closed_at||'').slice(0,10);
      const acts = h.actions?.join(' + ') || 'לא מצוין';
      techMsg += `\n🔧 ${date} — ${acts}`;
    });
  }
  if (recent >= 3) techMsg += `\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  techMsg += `\n\nכשתסיים — כתוב: סיימתי ${machine.site_name.split(' ')[0]}`;

  // עדכון קבוצה
  const groupMsg = `✅ ${machine.site_name}${machine.location?' | '+machine.location:''} | ${machine.machine_type}\n🔧 שויך ל${techName}`;

  // שלח לטכנאי ישירות
  const techPhones = {
    'אבשלום': process.env.PHONE_AVSHALOM,
    'בניה':   process.env.PHONE_BENIA,
    'שקד':    process.env.PHONE_SHAKED,
    'אלכס':   process.env.PHONE_ALEX,
    'גבי':    process.env.PHONE_GABI,
  };
  const techPhone = techPhones[techName];
  if (techPhone) await sendWhatsApp(techPhone, techMsg);

  // אפס סשן מלא
  const phone2 = s._phone;
  sessions[phone2] = { step: 'idle' };
  
  // החזר לאורי אישור קצר
  return `✅ שויך ל${techName} — הודעה נשלחה`;
}

async function doCloseTicket(s) {
  const ticket = await closeTicket(s.ticketId, s.actions, s.parts||[]);
  const siteCode = ticket?.customers?.site_code || s.siteCode;
  const hist3 = await getHistory(siteCode, 3);
  const recent = await countRecent(siteCode);

  // עדכן מלאי אם הוחלפו חלקים
  let inventoryAlerts = '';
  if (s.parts && s.parts.length > 0) {
    for (const part of s.parts) {
      const result = await deductInventory(part);
      if (result && result.newQty < 5) {
        inventoryAlerts += `\n⚠️ מלאי נמוך: ${result.name} — נותרו ${result.newQty}`;
      }
    }
  }

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

// ===== קריאת תמונה עם Claude API =====
async function readDeliveryNote(imageUrl) {
  // הורד את התמונה עם Twilio authentication
  const authHeader = 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
  const imgResponse = await fetch(imageUrl, {
    headers: { 'Authorization': authHeader }
  });
  const imgBuffer = await imgResponse.arrayBuffer();
  const imageData = Buffer.from(imgBuffer).toString('base64');
  const mediaType = imgResponse.headers.get('content-type') || 'image/jpeg';

  // שלח ל-Claude API
  const apiKey = (process.env.ANTHROPIC_KEY || '').trim();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageData }
          },
          {
            type: 'text',
            text: `This is a delivery note from Mayer's Coffee. Extract the following fields as JSON only, no extra text.

Instructions:
- note_type: "איסוף" if the items table contains "סיום התקשרות" or "איסוף מכונה" in the product name (שם פריט), otherwise "התקנה"
- collection_location: if note_type is "איסוף", extract the collection address/city from the product name (שם פריט) - it usually appears after "איסוף מכונה M12 -" or similar
- client_name: the customer name from the "לכבוד" (To) field at the top right - write exactly as appears INCLUDING spaces between words
- address: the street address below the customer name
- city: the city below the address
- machine_type: machine model like M12, F16, F15 from the items table
- machine_quantity: the quantity number from the "כמות" column in the items table (integer)
- contact_phone: the phone number next to the word "נייד" (mobile) in the top section - this is the customer phone
- contact_name: customer contact person name if shown
- delivery_note_number: the document number "מס'"
- driver: driver name at the bottom

Return only this JSON:
{ "note_type": "", "client_name": "", "address": "", "city": "", "collection_location": "", "machine_type": "", "machine_quantity": 1, "contact_name": "", "contact_phone": "", "delivery_note_number": "", "driver": "" }`
          }
        ]
      }]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) throw new Error('No response from Claude');
  const text = data.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}


// מיפוי חלקים לקודי מלאי
const PART_TO_INVENTORY = {
  'נשם': 'נשם חלב',
  'ברז חשמלי': 'ברז',
  'קפוצינטור': 'קפוצינטור',
  'יחידת חליטה': 'יחידת חליטה',
  'טרמובלוק (דוד)': 'מכלול דוד שלם'
};

async function deductInventory(partName) {
  // מצא את הפריט במלאי לפי שם חלקי
  const searchName = PART_TO_INVENTORY[partName] || partName;
  const {data: items} = await supabase
    .from('inventory')
    .select('id, part_name, quantity')
    .ilike('part_name', '%'+searchName+'%')
    .limit(1);
  
  if (!items || !items.length) return null;
  
  const item = items[0];
  const newQty = Math.max(0, (item.quantity || 0) - 1);
  
  await supabase
    .from('inventory')
    .update({ quantity: newQty, updated_at: new Date().toISOString() })
    .eq('id', item.id);
  
  return { name: item.part_name, oldQty: item.quantity, newQty };
}

async function checkLowInventory() {
  // בדוק פריטים עם כמות נמוכה (פחות מ-5)
  const {data} = await supabase
    .from('inventory')
    .select('part_name, quantity')
    .lt('quantity', 5)
    .gt('quantity', -1)
    .order('quantity');
  return data || [];
}

// ===== סגירת איסוף =====
async function doCollectMachine(s, machine) {
  const note = s.pendingCollection;
  
  if (machine) {
    await supabase.from('customers').update({ is_active: false }).eq('site_code', machine.site_code);
  }
  
  s.step = 'idle';
  const name = note?.client_name || machine?.site_name || '';
  const machineType = machine?.machine_type || note?.machine_type || '';
  const location = machine?.location ? ' | ' + machine.location : '';
  const techName = s.collectionTech?.name || '';

  const groupMsg = `✅ קבוצה:\n📤 ${name}${location} | ${machineType}\n🔧 מכונה נאספה ✓${techName ? ' על ידי ' + techName : ''}`;

  // שלח לאורי ועודד
  const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
  for (const p of oriPhones) {
    await sendWhatsApp(p, groupMsg);
  }

  return groupMsg;
}

// ===== סיכום יומי אלכס ב-18:00 =====
async function sendDailySummaryAlex() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const {data: jobs} = await supabase.from('lab_jobs')
    .select('*')
    .gte('started_at', today.toISOString())
    .not('completed_at', 'is', null)
    .order('started_at');
  
  if (!jobs || !jobs.length) return;
  
  let summary = `📋 סיכום מעבדה — ${today.toLocaleDateString('he-IL')}\n\n`;
  summary += '| מכונה | פעולה | חלקים |\n';
  summary += '|-------|--------|--------|\n';
  jobs.forEach(j => {
    const act = j.actions ? j.actions.join(' + ') : '—';
    const parts = j.parts?.length ? j.parts.join(', ') : '—';
    summary += `| ${j.machine_type} | ${act} | ${parts} |\n`;
  });
  summary += `\nסה"כ: ${jobs.length} מכונות תוקנו`;
  
  // שלח לאורי ועודד
  const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
  for (const p of oriPhones) {
    await sendWhatsApp(p, summary);
  }
  console.log('סיכום יומי אלכס נשלח:', summary);
}

// הרץ כל דקה ובדוק אם 18:00
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 18 && now.getMinutes() === 0) {
    sendDailySummaryAlex();
  }
}, 60000);

app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;
    console.log(`📨 ${from}: ${body}${mediaUrl?' [תמונה]':''}`);

    // טיפול בתמונה — תעודת התקנה
    if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const phone = from.replace('whatsapp:','');
      if (!sessions[phone]) sessions[phone] = {step:'idle'};
      const s = sessions[phone];

      // אם בשלב installation_confirm — זו תעודה עם חתימה (סגירה התקנה)
      if (s.step === 'installation_confirm') {
        await supabase.from('installations').update({
          signed_note_url: mediaUrl,
          completed_at: new Date().toISOString()
        }).eq('id', s.installationId);

        if (s.pendingCustomer) {
          await supabase.from('customers').insert({
            site_code: 'NEW-' + Date.now(),
            site_name: s.pendingCustomer.client_name,
            city: s.pendingCustomer.city,
            address: s.pendingCustomer.address,
            contact_name: s.pendingCustomer.contact_name,
            contact_phone: s.pendingCustomer.contact_phone,
            machine_type: s.pendingCustomer.machine_type,
            is_active: true
          }).select().single();
        }

        s.step = 'idle';
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(`✅ התקנה הושלמה ונרשמה!\n📍 ${s.pendingCustomer?.client_name || ''}\n🔧 ${s.pendingCustomer?.machine_type || ''}`);
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // אם בשלב collection_photo — זו תעודה עם חתימה (סגירה איסוף)
      if (s.step === 'collection_photo') {
        // סמן מכונות שנאספו כלא פעילות
        const machinesToDeactivate = s.selectedCollectionMachines || s.collectionMachines || [];
        const qty = s.pendingCollection?.machine_quantity || 1;
        const toDeactivate = machinesToDeactivate.slice(0, qty);

        for (const machine of toDeactivate) {
          await supabase.from('customers')
            .update({ is_active: false })
            .eq('id', machine.id);
        }

        const note = s.pendingCollection;
        s.step = 'idle';
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(`✅ איסוף הושלם!\n📍 ${note?.client_name || ''}\n🔧 ${toDeactivate.length} מכונות הוסרו ממסד הנתונים\n\n📲 קבוצה:\n🔄 ${note?.client_name || ''} — סיום התקשרות\n🔧 ${toDeactivate.length} מכונות נאספו על ידי ${s.collectionTech?.name || ''}`);
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // אחרת — תעודה חדשה מגבי
      try {
        const noteData = await readDeliveryNote(mediaUrl);
        sessions[phone].pendingNote = noteData;
        sessions[phone].step = 'installation_assign';

        const techs = await getTechnicians();
        sessions[phone].techs = techs;

        const isCollection = noteData.note_type === 'איסוף';
      const qty = noteData.machine_quantity || 1;

      if (isCollection) {
        // תהליך איסוף
        // חפש לפי שם + סנן לפי עיר
        const firstWord = noteData.client_name.split(' ')[0];
        let machineQuery = supabase.from('customers')
          .select('id, site_name, city, location, machine_type, site_code')
          .ilike('site_name', '%'+firstWord+'%')
          .eq('is_active', true)
          .limit(15);
        
        const {data: allMachines} = await machineQuery;
        // סנן לפי עיר אם יש
        let existingMachines = allMachines || [];
        // סנן לפי מיקום האיסוף (לא עיר הלקוח)
        const filterCity = noteData.collection_location || noteData.city;
        if (filterCity && existingMachines.length > 1) {
          const filtered = existingMachines.filter(m => 
            m.city?.includes(filterCity) || filterCity?.includes(m.city) ||
            m.site_name?.includes(filterCity)
          );
          if (filtered.length > 0) existingMachines = filtered;
        }

        sessions[phone].pendingCollection = noteData;
        sessions[phone].collectionMachines = existingMachines || [];
        sessions[phone].step = 'collection_assign';

        let machineList = '';
        if (existingMachines && existingMachines.length > 0) {
          machineList = '\n\n🔧 מכונות במסד:\n' + existingMachines.map((m,i) =>
            `${i+1}️⃣ ${m.location || 'לא מצוין'} | ${m.machine_type} | ${m.city}`
          ).join('\n');
        }

        const collectionCity = noteData.collection_location || noteData.city;
        const collCard = `🔄 סיום התקשרות זוהה!\n📍 ${noteData.client_name}\n🏙️ מיקום איסוף: ${collectionCity}\n🔧 ${noteData.machine_type} | כמות: ${qty}\n📄 תעודה: ${noteData.delivery_note_number}${machineList}\n\nלאיזה טכנאי לשייך?\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');
        
        const twiml2 = new twilio.twiml.MessagingResponse();
        twiml2.message(collCard);
        res.type('text/xml');
        return res.send(twiml2.toString());
      }

      // תהליך התקנה רגיל
      const {data: existingCustomer} = await supabase
        .from('customers')
        .select('site_name, city')
        .ilike('site_name', '%'+noteData.client_name.split(' ')[0]+'%')
        .eq('is_active', true)
        .limit(1);
      
      const isNew = !existingCustomer || existingCustomer.length === 0;
      const customerStatus = isNew ? `🆕 לקוח חדש` : `✅ לקוח קיים`;
      const qtyText = qty > 1 ? ` | ${qty} מכונות` : '';
      
      const card = `📦 התקנה חדשה זוהתה!\n${customerStatus}\n📍 ${noteData.client_name}\n🏙️ ${noteData.city}\n📬 ${noteData.address}\n🔧 ${noteData.machine_type}${qtyText}\n👤 ${noteData.contact_name} — ${noteData.contact_phone}\n📄 תעודה: ${noteData.delivery_note_number}\n\nלאיזה טכנאי לשייך?\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');

        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(card);
        res.type('text/xml');
        return res.send(twiml.toString());
      } catch(e) {
        console.error('שגיאה בקריאת תעודה:', e);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('לא הצלחתי לקרוא את התעודה — נסה שוב או שלח ידנית.');
        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

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

app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>מאיירס קפה — דשבורד תקלות</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f1117; color: #e8e8e8; padding: 24px; direction: rtl; }
  h1 { font-size: 22px; font-weight: 500; color: #fff; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1d27; border-radius: 10px; padding: 16px; border: 1px solid #2a2d3a; }
  .card-label { font-size: 12px; color: #666; margin-bottom: 6px; }
  .card-value { font-size: 26px; font-weight: 500; color: #fff; }
  .card-sub { font-size: 12px; color: #4ade80; margin-top: 4px; }
  .section { background: #1a1d27; border-radius: 10px; padding: 20px; border: 1px solid #2a2d3a; margin-bottom: 16px; }
  .section-title { font-size: 13px; font-weight: 500; color: #888; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .chart-wrap { position: relative; width: 100%; }
  .insight { background: #12151f; border-right: 3px solid #185FA5; padding: 12px 16px; border-radius: 6px; margin-bottom: 8px; font-size: 13px; color: #aaa; line-height: 1.6; }
  .insight span { color: #fff; font-weight: 500; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; margin-right: 4px; }
  .badge-blue { background: #0c447c; color: #85b7eb; }
  .badge-green { background: #085041; color: #5dcaa5; }
  .badge-orange { background: #714f0b; color: #ef9f27; }
  .badge-gray { background: #2c2c2a; color: #888780; }
  @media (max-width: 700px) { .cards { grid-template-columns: repeat(2, 1fr); } .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<h1>☕ מאיירס קפה — דשבורד תקלות</h1>
<p class="subtitle">אפריל 2025 — אפריל 2026 | 1,532 סגירות | ימי עבודה בלבד</p>

<div class="cards">
  <div class="card">
    <div class="card-label">סה"כ סגירות</div>
    <div class="card-value">1,532</div>
    <div class="card-sub">↑ מגמת עלייה</div>
  </div>
  <div class="card">
    <div class="card-label">ממוצע חודשי</div>
    <div class="card-value">128</div>
    <div class="card-sub">מרץ 2026 — שיא: 187</div>
  </div>
  <div class="card">
    <div class="card-label">טכנאי מוביל</div>
    <div class="card-value">אבשלום</div>
    <div class="card-sub">599 סגירות</div>
  </div>
  <div class="card">
    <div class="card-label">שעת עומס</div>
    <div class="card-value">11–13</div>
    <div class="card-sub">~40% מהסגירות</div>
  </div>
</div>

<div class="section">
  <div class="section-title">סגירות לפי חודש</div>
  <div class="chart-wrap" style="height:200px">
    <canvas id="monthChart"></canvas>
  </div>
</div>

<div class="grid-2">
  <div class="section">
    <div class="section-title">לפי טכנאי</div>
    <div class="chart-wrap" style="height:200px">
      <canvas id="techChart"></canvas>
    </div>
  </div>
  <div class="section">
    <div class="section-title">לפי שעה ביום</div>
    <div class="chart-wrap" style="height:200px">
      <canvas id="hourChart"></canvas>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">פעולות נפוצות (ללא "לא מצוין")</div>
  <div class="chart-wrap" style="height:280px">
    <canvas id="actionChart"></canvas>
  </div>
</div>

<div class="section">
  <div class="section-title">ביצועי טכנאים לפי חודש</div>
  <div class="chart-wrap" style="height:220px">
    <canvas id="techMonthChart"></canvas>
  </div>
</div>

<div class="section">
  <div class="section-title">תובנות עיקריות</div>
  <div class="insight"><span>שקד בעלייה חדה</span> — הצטרף אוקטובר 2025 עם 2 סגירות, ובמרץ 2026 כבר 98 — עקף את בניה.</div>
  <div class="insight"><span>החלפת מכונה</span> — הפעולה הנפוצה ביותר: 378 פעמים (25% מהסגירות המזוהות). שווה לבדוק אם יש לקוחות שחוזרים.</div>
  <div class="insight"><span>אוקטובר 2025 — ירידה</span> — רק 72 סגירות לעומת 141 באוגוסט. כנראה קשור לחגים / שינוי עונתי.</div>
  <div class="insight"><span>שעות עומס: 11:00–13:00</span> — 599 סגירות בשלוש שעות אלה. שעות הבוקר יותר פנויות.</div>
  <div class="insight"><span>מגמת עלייה</span> — ינואר–מרץ 2026 חזקים מכל הרביע המקביל. הצי גדל.</div>
</div>

<p style="font-size:11px; color:#333; text-align:center; margin-top:16px;">מאיירס קפה × Claude | נוצר אוטומטית</p>

<script>
const months = ['אפר 25','מאי 25','יונ 25','יול 25','אוג 25','ספט 25','אוק 25','נוב 25','דצמ 25','ינו 26','פבר 26','מרץ 26'];
const monthData = [124,114,100,130,141,129,72,111,108,134,175,187];

Chart.defaults.color = '#666';
Chart.defaults.borderColor = '#2a2d3a';

new Chart(document.getElementById('monthChart'), {
  type: 'bar',
  data: {
    labels: months,
    datasets: [{
      data: monthData,
      backgroundColor: monthData.map(v => v === Math.max(...monthData) ? '#378ADD' : '#185FA5'),
      borderRadius: 4
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => \` \${ctx.parsed.y} סגירות\` } } },
    scales: {
      x: { ticks: { font: { size: 11 }, autoSkip: false, maxRotation: 45 }, grid: { display: false } },
      y: { ticks: { font: { size: 11 } } }
    }
  }
});

new Chart(document.getElementById('techChart'), {
  type: 'doughnut',
  data: {
    labels: ['אבשלום', 'בניה', 'שקד', 'אלכס'],
    datasets: [{
      data: [599, 521, 236, 176],
      backgroundColor: ['#185FA5','#1D9E75','#D85A30','#5F5E5A'],
      borderWidth: 0, hoverOffset: 4
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 10, color: '#aaa' } },
      tooltip: { callbacks: { label: ctx => \` \${ctx.label}: \${ctx.parsed} (\${Math.round(ctx.parsed/1532*100)}%)\` } }
    }
  }
});

new Chart(document.getElementById('hourChart'), {
  type: 'bar',
  data: {
    labels: ['7','8','9','10','11','12','13','14','15','16','17','18'],
    datasets: [{
      data: [3,61,174,170,203,205,191,172,179,109,53,10],
      backgroundColor: '#0F6E56',
      borderRadius: 3
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { font: { size: 11 } }, grid: { display: false } },
      y: { ticks: { font: { size: 11 } } }
    }
  }
});

new Chart(document.getElementById('actionChart'), {
  type: 'bar',
  data: {
    labels: ['החלפת מכונה','טיפול אבנית','החלפת ברז חשמלי','החלפת תבריג','החלפת צינורית חלב','החלפת נשם','החלפת מקרר','החלפת קפוצינטור','החלפת בילט'],
    datasets: [{
      data: [378,179,66,64,62,61,60,51,8],
      backgroundColor: ['#D85A30','#BA7517','#185FA5','#185FA5','#185FA5','#185FA5','#185FA5','#185FA5','#5F5E5A'],
      borderRadius: 3
    }]
  },
  options: {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => \` \${ctx.parsed.x} פעמים\` } } },
    scales: {
      x: { ticks: { font: { size: 11 } } },
      y: { ticks: { font: { size: 11 } }, grid: { display: false } }
    }
  }
});

new Chart(document.getElementById('techMonthChart'), {
  type: 'line',
  data: {
    labels: months,
    datasets: [
      { label: 'אבשלום', data: [46,40,40,52,40,54,31,50,57,63,67,59], borderColor: '#185FA5', backgroundColor: 'transparent', tension: 0.3, pointRadius: 3 },
      { label: 'בניה', data: [57,41,50,67,78,55,26,27,32,35,28,25], borderColor: '#1D9E75', backgroundColor: 'transparent', tension: 0.3, pointRadius: 3 },
      { label: 'שקד', data: [0,0,0,0,0,0,2,14,15,27,75,98], borderColor: '#D85A30', backgroundColor: 'transparent', tension: 0.3, pointRadius: 3 },
      { label: 'אלכס', data: [21,33,10,11,23,20,13,20,4,9,5,5], borderColor: '#888780', backgroundColor: 'transparent', tension: 0.3, pointRadius: 3 }
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, boxWidth: 12, color: '#aaa' } }
    },
    scales: {
      x: { ticks: { font: { size: 11 }, autoSkip: false, maxRotation: 45 }, grid: { display: false } },
      y: { ticks: { font: { size: 11 } } }
    }
  }
});
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`בוט פועל על פורט ${PORT}`));
