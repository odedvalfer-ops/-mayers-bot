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

  // חפש לפי שם לקוח
  const {data} = await supabase.from('customers').select('*')
    .ilike('site_name','%'+clientName+'%').eq('is_active',true).limit(20);
  
  if (!data || data.length === 0) return [];
  
  // סנן לפי עיר אם יש
  if (cityName && cityName.length > 1) {
    const filtered = data.filter(c => 
      c.city?.includes(cityName) || 
      c.site_name?.includes(cityName)
    );
    if (filtered.length > 0) return filtered.slice(0,8);
  }
  
  return data.slice(0,8);
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
  // הורד את התמונה
  const imgResponse = await fetch(imageUrl);
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
            text: 'זוהי תעודת משלוח של מכונת קפה. חלץ את הפרטים הבאים בפורמט JSON בלבד ללא שום טקסט נוסף: { "client_name": "שם הלקוח", "address": "כתובת מלאה", "city": "עיר", "machine_type": "סוג מכונה", "contact_name": "איש קשר", "contact_phone": "טלפון", "delivery_note_number": "מספר תעודה", "driver": "שם הנהג" }'
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
  
  console.log('סיכום יומי אלכס:', summary);
  // כשיהיה מספר אמיתי — לשלוח לאורי
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

      // אם בשלב installation_confirm — זו תעודה עם חתימה (סגירה)
      if (s.step === 'installation_confirm') {
        await supabase.from('installations').update({
          signed_note_url: mediaUrl,
          completed_at: new Date().toISOString()
        }).eq('id', s.installationId);

        // עדכן לקוח חדש במסד
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

      // אחרת — תעודה חדשה מגבי
      try {
        const noteData = await readDeliveryNote(mediaUrl);
        sessions[phone].pendingNote = noteData;
        sessions[phone].step = 'installation_assign';

        const techs = await getTechnicians();
        sessions[phone].techs = techs;

        const card = `📦 התקנה חדשה זוהתה!\n📍 ${noteData.client_name}\n🏙️ ${noteData.city}\n📬 ${noteData.address}\n🔧 ${noteData.machine_type}\n👤 ${noteData.contact_name} — ${noteData.contact_phone}\n📄 תעודה: ${noteData.delivery_note_number}\n\nלאיזה טכנאי לשייך?\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`בוט פועל על פורט ${PORT}`));
