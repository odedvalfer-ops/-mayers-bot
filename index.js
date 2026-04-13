require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = 'whatsapp:+972584820015';

// ===== תפריטים =====
const ACTION_MENU = 'מה עשית?\n1️⃣ החלפת מכונה\n2️⃣ טיפול אבנית\n3️⃣ טיפול מטחנה\n4️⃣ ניקיון הקצפה\n5️⃣ החלפת חלק\n6️⃣ אחר — ציין ידנית';
const MORE_MENU = 'עשית משהו נוסף?\n1️⃣ החלפת מכונה\n2️⃣ טיפול אבנית\n3️⃣ טיפול מטחנה\n4️⃣ ניקיון הקצפה\n5️⃣ החלפת חלק\n6️⃣ אחר — ציין ידנית\n7️⃣ לא — סגור תקלה';
const PART_MENU = 'איזה חלק?\n1️⃣ ברז חשמלי\n2️⃣ תבריג\n3️⃣ צינורית חלב\n4️⃣ נשם\n5️⃣ מקרר\n6️⃣ קפוצינטור\n7️⃣ בילט\n8️⃣ יחידת חליטה\n9️⃣ אחר — ציין ידנית';

const ACTIONS = {'1':'החלפת מכונה','2':'טיפול אבנית','3':'טיפול מטחנה','4':'ניקיון הקצפה','5':'החלפת חלק','6':'אחר'};
const PARTS = {'1':'ברז חשמלי','2':'תבריג','3':'צינורית חלב','4':'נשם','5':'מקרר','6':'קפוצינטור','7':'בילט','8':'יחידת חליטה','9':'אחר'};
const FAULT_WORDS = ['תקלה','לא מושך','לא מקציף','לא עובד','לא נדלק','לא יוצא','לא פועל','להחליף','לא מחמם'];
const STOP_WORDS = new Set(['לא','של','את','עם','על','אל','כן','בלי','רק','תקלה','מושך','מקציף','עובד','נדלק','יוצא','פועל','מחמם']);

const ISRAEL_CITIES = new Set([
  'תל אביב','ירושלים','חיפה','ראשון לציון','פתח תקווה','אשדוד','נתניה','באר שבע',
  'בני ברק','חולון','רמת גן','אשקלון','רחובות','בת ים','בית שמש','קריית גת',
  'הרצליה','חדרה','מודיעין','לוד','רמלה','עכו','אילת','נצרת','עפולה',
  'ראש העין','קריית אתא','קריית ביאליק','קריית מוצקין','קריית ים','קריית שמונה',
  'הוד השרון','נס ציונה','טבריה','צפת','כפר סבא','רעננה','רמת השרון',
  'גבעתיים','קריית אונו','אור יהודה','קריית מלאכי','דימונה','ערד','מצפה רמון',
  'נהריה','טירת כרמל','יוקנעם','זכרון יעקב','קיסריה','אבן יהודה','כפר יונה',
  'נתיבות','שדרות','אופקים','ירוחם','מגדל העמק','נשר','טמרה','שפרעם','סכנין',
  'אום אל פחם','בית שאן','מעלה אדומים','ביתר עילית','אלעד','מודיעין עילית',
  'פרדס חנה','בנימינה','גבעת שמואל','גני תקווה','אור עקיבא','חריש','נוף הגליל',
  'קריית טבעון','טירה','קלנסווה','יבנה','גדרה','מזכרת בתיה','באר יעקב',
  'שוהם','כפר קאסם','טייבה','כפר יאסיף'
]);

function extractCityFromMsg(msg) {
  const twoCities = Array.from(ISRAEL_CITIES).filter(c => c.includes(' '));
  for (const city of twoCities) {
    if (msg.includes(city)) return city;
  }
  const oneCities = Array.from(ISRAEL_CITIES).filter(c => !c.includes(' '));
  const words = msg.split(/\s+/);
  for (const word of words) {
    if (oneCities.includes(word)) return word;
  }
  return '';
}

function fmtDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function fmtTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

const sessions = {};

// ===== DB =====
async function searchCustomers(clientName, cityName) {
  if (!clientName || clientName.length < 2) return [];
  const {data} = await supabase.from('customers').select('*')
    .ilike('site_name','%'+clientName+'%').eq('is_active',true).limit(20);
  let results = data || [];
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
  if (results.length === 0) {
    const {data: similar} = await supabase.rpc('search_customers_fuzzy', {
      search_term: clientName, threshold: 0.2
    });
    results = similar || [];
  }
  if (!results.length) return [];
  if (cityName && cityName.length > 1) {
    const filtered = results.filter(c =>
      c.city?.includes(cityName) || c.site_name?.includes(cityName)
    );
    if (filtered.length > 0) return filtered.slice(0,8);
  }
  return results.slice(0,8);
}

async function getCustomerMachines(siteName, cityName='') {
  const {data: exact} = await supabase.from('customers').select('*').eq('site_name', siteName).eq('is_active',true).limit(1);
  if (exact && exact.length > 0 && exact[0].customer_id) {
    let query = supabase.from('customers').select('*').eq('customer_id', exact[0].customer_id).eq('is_active',true);
    if (cityName && cityName.length > 1) query = query.ilike('city', '%'+cityName+'%');
    const {data} = await query.limit(15);
    if (data && data.length > 0) return data;
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
  const {data} = await supabase.from('technicians').select('*').in('role',['field','lab']).eq('is_active',true);
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

// ===== INVENTORY =====
const PART_TO_INVENTORY = {
  'ברז חשמלי': 'ברז',
  'נשם': 'נשם חלב',
  'קפוצינטור': 'קפוצינטור',
  'יחידת חליטה': 'יחידת חליטה',
  'מקרר': 'מקרר',
  'תבריג': 'תבריג',
  'צינורית חלב': 'צינוריות לחלב',
  'בילט': 'החלפת בילט'
};

async function deductInventory(partName) {
  const searchName = PART_TO_INVENTORY[partName] || partName;
  const {data: items} = await supabase.from('inventory').select('id, part_name, quantity')
    .ilike('part_name', '%'+searchName+'%').limit(1);
  if (!items || !items.length) return null;
  const item = items[0];
  const newQty = Math.max(0, (item.quantity || 0) - 1);
  await supabase.from('inventory').update({ quantity: newQty, updated_at: new Date().toISOString() }).eq('id', item.id);
  return { name: item.part_name, oldQty: item.quantity, newQty };
}

// ===== WHATSAPP =====
async function sendWhatsApp(toPhone, message) {
  try {
    let num = String(toPhone).replace(/\D/g,'');
    if (num.startsWith('0')) num = '972' + num.slice(1);
    if (!num.startsWith('972')) num = '972' + num;
    const to = '+' + num;
    console.log('📤 שולח ל:', to);
    await twilioClient.messages.create({ from: TWILIO_NUMBER, to: `whatsapp:${to}`, body: message });
    console.log('✅ נשלח ל', to);
  } catch(e) {
    console.error('❌ שגיאה בשליחה:', toPhone, e.message);
  }
}

// ===== USER ROLES =====
function getUserRole(phone) {
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

const techPhones = {
  'אבשלום': process.env.PHONE_AVSHALOM,
  'בניה':   process.env.PHONE_BENIA,
  'שקד':    process.env.PHONE_SHAKED,
  'אלכס':   process.env.PHONE_ALEX,
  'גבי':    process.env.PHONE_GABI,
};

// ===== שליחה לכולם =====
async function broadcastAll(message) {
  const allPhones = [
    process.env.PHONE_ORI,
    process.env.PHONE_ODED,
    process.env.PHONE_AVSHALOM,
    process.env.PHONE_BENIA,
    process.env.PHONE_SHAKED,
    process.env.PHONE_ALEX,
    process.env.PHONE_GABI,
    process.env.PHONE_DUDI,
    process.env.PHONE_AMIR,
  ].filter(Boolean);
  for (const p of allPhones) {
    await sendWhatsApp(p, message);
  }
}

// ===== MAIN HANDLER =====
async function handleMessage(from, body) {
  const phone = from.replace('whatsapp:','');
  const msg = body.trim();
  if (!sessions[phone]) sessions[phone] = {step:'idle'};
  const s = sessions[phone];
  s._phone = phone;
  const user = getUserRole(phone);
  s.userName = user.name;
  s.userRole = user.role;

  // ===== איפוס =====
  if (msg === 'איפוס' || msg === 'reset') {
    sessions[phone] = { step: 'idle' };
    return '✅ סשן אופס — אפשר להתחיל מחדש';
  }

  // ===== מה פתוח =====
  if (msg === 'מה פתוח') {
    return await handleWhatOpen(s, user);
  }

  // ===== שייך [מספר] =====
  if (msg.startsWith('שייך ') && (user.role === 'manager' || user.role === 'agent')) {
    const idx = parseInt(msg.replace('שייך','').trim()) - 1;
    if (!isNaN(idx) && s.openList && idx >= 0 && idx < s.openList.length) {
      const ticket = s.openList[idx];
      s.assigningTicket = ticket;
      const techs = await getTechnicians();
      s.techs = techs;
      s.step = 'assign_existing_ticket';
      return `בחר טכנאי ל${ticket.customers?.site_name}:\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');
    }
    return 'כתוב: שייך [מספר] לפי הרשימה';
  }

  // ===== IDLE =====
  if (s.step === 'idle') {

    // סגירה: "סיימתי [לקוח]"
    if (msg.startsWith('סיימתי')) {
      const rest = msg.replace('סיימתי','').trim();
      const words = rest.split(/\s+/);
      const clientWord = words[0] || '';

      const {data: openTickets} = await supabase.from('tickets')
        .select('*,customers(site_name,site_code,machine_type,location,city)')
        .eq('status','open').order('opened_at',{ascending:false});

      // סנן לפי טכנאי אם לא מנהל
      let myTickets = openTickets || [];
      if (user.role === 'technician' || user.role === 'lab') {
        const {data: tech} = await supabase.from('technicians').select('id').eq('name', user.name).single();
        if (tech) myTickets = myTickets.filter(t => t.technician_id === tech.id);
      }

      const matched = myTickets.filter(t => t.customers?.site_name?.includes(clientWord));
      if (!matched.length) return `לא מצאתי תקלה פתוחה עבור "${clientWord}"`;

      if (matched.length === 1) {
        s.ticketId = matched[0].id;
        s.siteCode = matched[0].customers?.site_code;
        s.closingMachine = matched[0].customers?.location || matched[0].customers?.machine_type;
        s.closingSiteName = matched[0].customers?.site_name;
        s.openedAt = matched[0].opened_at;
        s.actions = [];
        s.parts = [];
        s.step = 'closing_action';
        return ACTION_MENU;
      }

      s.step = 'select_close_ticket';
      s.openTickets = matched;
      return 'איזו תקלה לסגור?\n' + matched.map((t,i) =>
        `${i+1}️⃣ ${t.customers?.site_name}${t.customers?.location?' | '+t.customers.location:''}`
      ).join('\n');
    }

    // פתיחת תקלה
    const isFault = FAULT_WORDS.some(w => msg.includes(w));
    if (isFault) {
      const cityName = extractCityFromMsg(msg);
      let clientText = msg;
      if (cityName) clientText = clientText.split(cityName).join(' ');
      FAULT_WORDS.forEach(w => { clientText = clientText.split(w).join(' '); });
      ['לא','של','את','עם','על','בלי','רק'].forEach(w => { clientText = clientText.split(' '+w+' ').join(' '); });
      clientText = clientText.replace(/[^\u05d0-\u05eaA-Za-z0-9 ]/g,' ').replace(/ +/g,' ').trim();
      const clientName = clientText;
      if (clientName.length < 2) return 'מה שם הלקוח?';

      let customers = await searchCustomers(clientName, cityName);
      if (!customers.length) return `לא מצאתי לקוח בשם "${clientName}"${cityName?' ב'+cityName:''} — בדוק את השם ונסה שוב.`;

      // חלץ רק את תיאור התקלה — הסר שם לקוח, עיר, מילות תקלה
      let faultOnly = msg;
      if (cityName) faultOnly = faultOnly.split(cityName).join(' ');
      // הסר שם לקוח
      const clientWords = clientText.split(' ');
      clientWords.forEach(w => { if (w.length > 1) faultOnly = faultOnly.split(w).join(' '); });
      // נקה
      faultOnly = faultOnly.replace(/[^א-תA-Za-z0-9 ]/g,' ').replace(/ +/g,' ').trim();
      // אם נשאר רק "תקלה" — השתמש בהודעה המקורית
      if (faultOnly.length < 3 || faultOnly === 'תקלה') faultOnly = msg;
      s.faultDesc = faultOnly;
      s.cityName = cityName;

      if (customers.length === 1) {
        // אישור לקוח לשולח
        s.step = 'confirm_customer';
        s.customers = customers;
        const c = customers[0];
        return `📍 ${c.site_name}\n🏙️ ${c.city || ''}${c.machine_type?' | 🔧 '+c.machine_type:''}${c.address?' | 📬 '+c.address:''}\n👤 ${c.contact_name||''}${c.contact_phone?' — '+c.contact_phone:''}\n\nזה הלקוח? 1️⃣ כן | 2️⃣ לא`;
      }

      s.step = 'select_customer';
      s.customers = customers;
      return `מצאתי כמה תוצאות:\n` +
        customers.map((c,i) => `${i+1}️⃣ ${c.site_name} — ${c.city}${c.location?' | '+c.location:''}`).join('\n');
    }

    // מעבדה — אלכס
    if (msg === 'מתחיל עבודה' || msg.startsWith('מתחיל עבודה')) {
      s.step = 'lab_select_machine';
      return 'איזו מכונה?\n1️⃣ M12\n2️⃣ F16\n3️⃣ F15';
    }

    return null;
  }

  // ===== אישור לקוח =====
  if (s.step === 'confirm_customer') {
    if (msg === '1') {
      return await handleOneCustomer(s, s.customers[0], phone);
    }
    if (msg === '2') {
      s.step = 'idle';
      return 'בסדר, נסה שוב עם שם אחר';
    }
    return `זה הלקוח? 1️⃣ כן | 2️⃣ לא`;
  }

  // ===== בחירת לקוח =====
  if (s.step === 'select_customer') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.customers||[]).length) {
      const c = s.customers[idx];
      s.step = 'confirm_customer';
      s.customers = [c];
      return `📍 ${c.site_name}\n🏙️ ${c.city || ''}${c.machine_type?' | 🔧 '+c.machine_type:''}${c.address?' | 📬 '+c.address:''}\n👤 ${c.contact_name||''}${c.contact_phone?' — '+c.contact_phone:''}\n\nזה הלקוח? 1️⃣ כן | 2️⃣ לא`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת מכונה =====
  if (s.step === 'select_machine') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.machines||[]).length) {
      return await buildShiuach(s, s.machines[idx], phone);
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== שיוך טכנאי לתקלה קיימת =====
  if (s.step === 'assign_existing_ticket') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      const tech = s.techs[idx];
      const ticket = s.assigningTicket;
      await assignTechnician(ticket.id, tech.name);

      // הודעה לטכנאי
      const machine = ticket.customers;
      const hist = await getHistory(machine?.site_code);
      const recent = await countRecent(machine?.site_code);
      let techMsg = `📋 קריאה חדשה!\n📍 ${machine?.site_name}`;
      if (machine?.address) techMsg += `\n📬 ${machine.address}`;
      if (machine?.city) techMsg += `, ${machine.city}`;
      if (machine?.location) techMsg += `\n🏢 ${machine.location}`;
      techMsg += `\n🔧 ${machine?.machine_type}`;
      techMsg += `\n⚠️ ${ticket.description}`;
      if (machine?.contact_name) techMsg += `\n👤 ${machine.contact_name}`;
      if (machine?.contact_phone) techMsg += ` — ${machine.contact_phone}`;
      if (hist && hist.length > 0) {
        techMsg += `\n\n📜 תקלות אחרונות:`;
        hist.slice(0,2).forEach(h => {
          techMsg += `\n🔧 ${(h.closed_at||'').slice(0,10)} — ${h.actions?.join(' + ') || 'לא מצוין'}`;
        });
      }
      if (recent >= 3) techMsg += `\n⚠️ ${recent} תקלות ב-60 יום`;
      techMsg += `\n\nכשתסיים — כתוב: סיימתי ${machine?.site_name?.split(' ')[0]}`;

      // לקבוצה
      const groupMsg = `🔧 תקלה חדשה\n📍 ${machine?.site_name}${machine?.location?' | '+machine.location:''}\n🔧 ${machine?.machine_type}\n⚠️ ${ticket.description}\n👨‍🔧 שויך ל${tech.name}`;

      const techPhone = techPhones[tech.name];
      if (techPhone) await sendWhatsApp(techPhone, techMsg);
      await broadcastAll(groupMsg);

      s.step = 'idle';
      return `✅ שויך ל${tech.name}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== שיוך טכנאי =====
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
      s.openedAt = t.opened_at;
      s.actions = [];
      s.parts = [];
      s.step = 'closing_action';
      return ACTION_MENU;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== פעולת סגירה =====
  if (s.step === 'closing_action') {
    if (ACTIONS[msg]) {
      if (msg === '5') { s.step = 'closing_part'; return PART_MENU; }
      if (msg === '6') {
        s.step = 'closing_action_other';
        return 'מה עשית? (ציין ידנית)';
      }
      s.actions = [ACTIONS[msg]];
      s.step = 'closing_more';
      return MORE_MENU;
    }
    return ACTION_MENU;
  }

  // ===== פעולה ידנית =====
  if (s.step === 'closing_action_other') {
    s.actions = [msg];
    s.step = 'closing_more';
    return MORE_MENU;
  }

  // ===== בחירת חלק =====
  if (s.step === 'closing_part') {
    if (PARTS[msg]) {
      const partName = msg === '9' ? null : PARTS[msg];
      if (msg === '9') {
        s.step = 'closing_part_other';
        return 'איזה חלק? (ציין ידנית)';
      }
      s.actions.push('החלפת חלק');
      s.parts.push(partName);
      s.step = 'closing_more';
      return MORE_MENU;
    }
    return PART_MENU;
  }

  // ===== חלק ידני =====
  if (s.step === 'closing_part_other') {
    s.actions.push('החלפת חלק');
    s.parts.push(msg);
    s.step = 'closing_more';
    return MORE_MENU;
  }

  // ===== עוד פעולה? =====
  if (s.step === 'closing_more') {
    if (msg === '7') return await doCloseTicket(s);
    if (msg === '5') { s.step = 'closing_part'; return PART_MENU; }
    if (msg === '6') { s.step = 'closing_action_other'; return 'מה עשית? (ציין ידנית)'; }
    if (ACTIONS[msg] && !s.actions.includes(ACTIONS[msg])) s.actions.push(ACTIONS[msg]);
    return MORE_MENU;
  }

  // ===== מעבדה — בחירת מכונה =====
  if (s.step === 'lab_select_machine') {
    const machines = {'1':'M12','2':'F16','3':'F15'};
    if (machines[msg]) {
      s.labMachine = machines[msg];
      s.labStart = new Date().toISOString();
      s.step = 'lab_working';
      const timeStr = fmtTime(s.labStart);
      supabase.from('lab_jobs').insert({
        machine_type: s.labMachine, started_at: s.labStart, technician_id: null
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
      if (msg === '5') { s.step = 'lab_part'; return PART_MENU; }
      if (msg === '6') { s.step = 'lab_action_other'; return 'מה עשית? (ציין ידנית)'; }
      s.actions = [ACTIONS[msg]];
      s.step = 'lab_more';
      return MORE_MENU;
    }
    return ACTION_MENU;
  }

  if (s.step === 'lab_action_other') {
    s.actions = [msg];
    s.step = 'lab_more';
    return MORE_MENU;
  }

  // ===== מעבדה — חלק =====
  if (s.step === 'lab_part') {
    if (PARTS[msg]) {
      if (msg === '9') { s.step = 'lab_part_other'; return 'איזה חלק? (ציין ידנית)'; }
      s.actions.push('החלפת חלק');
      s.parts.push(PARTS[msg]);
      s.step = 'lab_more';
      return MORE_MENU;
    }
    return PART_MENU;
  }

  if (s.step === 'lab_part_other') {
    s.actions.push('החלפת חלק');
    s.parts.push(msg);
    s.step = 'lab_more';
    return MORE_MENU;
  }

  // ===== מעבדה — עוד פעולה =====
  if (s.step === 'lab_more') {
    if (msg === '7') {
      const endTime = new Date().toISOString();
      const actText = s.actions.join(' + ');
      const partsText = s.parts?.length ? s.parts.join(', ') : '—';
      await supabase.from('lab_jobs').update({
        completed_at: endTime, actions: s.actions, parts: s.parts
      }).eq('machine_type', s.labMachine).is('completed_at', null);
      if (s.parts && s.parts.length > 0) {
        for (const part of s.parts) await deductInventory(part);
      }
      s.step = 'idle';
      return `✅ עבודת מעבדה הושלמה\n🔧 ${s.labMachine} | ${actText}\nחלקים: ${partsText}\n⏰ ${fmtTime(s.labStart)} — ${fmtTime(endTime)}`;
    }
    if (msg === '5') { s.step = 'lab_part'; return PART_MENU; }
    if (msg === '6') { s.step = 'lab_action_other'; return 'מה עשית? (ציין ידנית)'; }
    if (ACTIONS[msg] && !s.actions.includes(ACTIONS[msg])) s.actions.push(ACTIONS[msg]);
    return MORE_MENU;
  }

  // ===== שיוך טכנאי לאיסוף =====
  if (s.step === 'collection_assign') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      const tech = s.techs[idx];
      const note = s.pendingCollection;
      const machines = s.collectionMachines || [];
      const qty = note.machine_quantity || 1;

      let machineInfo = machines.length > 0
        ? '\n🔧 מכונות:\n' + machines.map((m,i) => {
            const letter = String.fromCharCode(0x05D0 + i); // א, ב, ג...
            return `${letter}) ${m.location||'לא מצוין'} | ${m.machine_type}`;
          }).join('\n')
        : '';

      const techMsg = `🔄 משימת איסוף!\n📍 ${note.client_name}\n🏙️ ${note.city}\n📬 ${note.address||''}\n🔧 לאסוף ${qty} מכונות${machineInfo}\n👤 ${note.contact_name||''} ${note.contact_phone||''}\n\nכשתסיים — צלם תעודה חתומה ושלח עם המילה: נאסף`;

      if (machines.length > qty) {
        s.step = 'collection_select_machines';
        s.collectionTech = tech;
        s.collectionQty = qty;
        const list = machines.map((m,i) => {
          const letter = String.fromCharCode(0x05D0 + i);
          return `${letter}) ${m.location||'לא מצוין'} | ${m.machine_type} | ${m.city}`;
        }).join('\n');
        return `✅ שויך ל${tech.name}\n\n[הודעה ל${tech.name}]\n${techMsg}\n\nיש ${machines.length} מכונות — אילו ${qty} נאספות?\n${list}\n\nבחר באותיות (לדוגמה: א,ג)`;
      }

      s.step = 'collection_confirm';
      s.collectionTech = tech;

      const techPhone = techPhones[tech.name];
      if (techPhone) await sendWhatsApp(techPhone, techMsg);

      const collectionOpenMsg = `🔄 איסוף נפתח\n📍 ${note.client_name}\n🏙️ ${note.city}\n🔧 ${note.machine_type} | כמות: ${qty}\n👨‍🔧 שויך ל${tech.name}`;
      await broadcastAll(collectionOpenMsg);

      // נקה את הסשן של המנהל השני
      const otherManagersC = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(p => p && p !== s._phone);
      for (const op of otherManagersC) {
        if (sessions[op] && sessions[op].step === 'collection_assign') {
          sessions[op] = { step: 'idle' };
        }
      }

      return `✅ שויך ל${tech.name}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== בחירת מכונות לאיסוף =====
  if (s.step === 'collection_select_machines') {
    const letters = msg.split(',').map(l => l.trim());
    const machines = s.collectionMachines || [];
    const selected = letters.map(l => {
      const idx = l.charCodeAt(0) - 0x05D0;
      return machines[idx];
    }).filter(Boolean);
    if (selected.length === 0) return 'בחר אותיות מהרשימה (לדוגמה: א,ג)';
    s.selectedCollectionMachines = selected;
    s.step = 'collection_confirm';
    const list = selected.map(m => `• ${m.location||'לא מצוין'} | ${m.machine_type}`).join('\n');

    const techPhone = techPhones[s.collectionTech?.name];
    const note = s.pendingCollection;
    const techMsg = `🔄 משימת איסוף!\n📍 ${note.client_name}\n🏙️ ${note.city}\n📬 ${note.address||''}\n🔧 מכונות לאיסוף:\n${list}\n👤 ${note.contact_name||''} ${note.contact_phone||''}\n\nכשתסיים — צלם תעודה חתומה ושלח עם המילה: נאסף`;
    if (techPhone) await sendWhatsApp(techPhone, techMsg);

    return `✅ מכונות שנאספות:\n${list}\n\nממתין לאישור טכנאי (נאסף + תעודה)`;
  }

  // ===== שיוך טכנאי להתקנה =====
  if (s.step === 'installation_assign') {
    const idx = parseInt(msg) - 1;
    if (idx >= 0 && idx < (s.techs||[]).length) {
      const tech = s.techs[idx];
      const note = s.pendingNote;
      const qty = note.machine_quantity || 1;

      const {data: inst} = await supabase.from('installations').insert({
        site_code: null,
        delivery_note_number: note.delivery_note_number,
        machine_type: note.machine_type,
        location: note.address,
        technician_id: tech.id,
        notes: JSON.stringify(note)
      }).select().single();

      s.installationId = inst?.id;
      s.installationQty = qty;
      s.installationTech = tech;
      s.pendingCustomer = note;
      s.step = 'idle';

      // נקה את הסשן של המנהל השני
      const otherManagers = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(p => p && p !== s._phone);
      for (const op of otherManagers) {
        if (sessions[op] && sessions[op].step === 'installation_assign') {
          sessions[op] = { step: 'idle' };
        }
      }

      const qtyText = qty > 1 ? ` | ${qty} מכונות` : '';
      const techMsg = `📦 משימת התקנה חדשה!\n📍 ${note.client_name}\n🏙️ ${note.city}\n📬 ${note.address}\n🔧 ${note.machine_type}${qtyText}\n👤 ${note.contact_name} — ${note.contact_phone}\n\nכשתסיים — צלם תעודה חתומה ושלח עם המילה: הותקן`;

      // לקבוצת התקנות
      const groupMsg = `📦 התקנה חדשה נפתחה\n📍 ${note.client_name} | ${note.city}\n🔧 ${note.machine_type}${qtyText}\n👨‍🔧 שויך ל${tech.name}`;

      const techPhone = techPhones[tech.name];
      if (techPhone) await sendWhatsApp(techPhone, techMsg);
      await broadcastAll(groupMsg);

      return `✅ שויך ל${tech.name}`;
    }
    return 'בחר מספר מהרשימה';
  }

  // ===== סגירת התקנה — מיקומים =====
  if (s.step === 'installation_location') {
    const qty = s.installationQty || 1;
    s.installationLocations = s.installationLocations || [];
    s.installationLocations.push(msg);

    if (s.installationLocations.length < qty) {
      return `מכונה ${s.installationLocations.length + 1} — איפה?`;
    }

    // כל המיקומים התקבלו — עדכן מסד
    const locations = s.installationLocations;
    await supabase.from('installations').update({
      signed_note_url: s.installationPhotoUrl,
      completed_at: new Date().toISOString(),
      notes: JSON.stringify({...s.pendingCustomer, locations})
    }).eq('id', s.installationId);

    // הוסף לקוחות עם מיקומים
    for (let i = 0; i < locations.length; i++) {
      await supabase.from('customers').insert({
        site_code: 'NEW-' + Date.now() + '-' + i,
        site_name: s.pendingCustomer?.client_name,
        city: s.pendingCustomer?.city,
        address: s.pendingCustomer?.address,
        contact_name: s.pendingCustomer?.contact_name,
        contact_phone: s.pendingCustomer?.contact_phone,
        machine_type: s.pendingCustomer?.machine_type,
        location: locations[i],
        is_active: true
      });
    }

    const locationList = locations.map((l,i) => `📌 מכונה ${i+1} — ${l}`).join('\n');
    const groupMsg = `✅ התקנה הושלמה\n📍 ${s.pendingCustomer?.client_name} | ${s.pendingCustomer?.city}\n🔧 ${s.pendingCustomer?.machine_type} | כמות: ${qty}\n${locationList}\n👨‍🔧 ${s.installationTech?.name}`;

    s.step = 'idle';
    await broadcastAll(groupMsg);
    return groupMsg;
  }

  // ===== נאסף =====
  if ((msg === 'נאסף' || msg.startsWith('נאסף ')) && s.step !== 'collection_photo' && s.step !== 'collection_which_machine') {
    const clientWord = msg.replace('נאסף','').trim();
    let machines = s.collectionMachines || [];
    if (machines.length === 0 && clientWord.length > 1) {
      const {data} = await supabase.from('customers')
        .select('site_code, site_name, city, location, machine_type')
        .ilike('site_name', '%'+clientWord+'%').eq('is_active', true).limit(10);
      machines = data || [];
      s.collectionMachines = machines;
    }
    if (machines.length === 0) return 'לא מצאתי מכונות — כתוב: נאסף [שם לקוח]';
    if (machines.length === 1) return await doCollectMachine(s, machines[0]);
    s.step = 'collection_which_machine';
    const list = machines.map((m,i) => {
      const letter = String.fromCharCode(0x05D0 + i);
      return `${letter}) ${m.site_name}${m.location?' | '+m.location:''} | ${m.machine_type} | ${m.city}`;
    }).join('\n');
    return `איזו מכונה נאספה?\n${list}`;
  }

  if (s.step === 'collection_which_machine') {
    const machines = s.collectionMachines || [];
    const letter = msg.trim();
    const idx = letter.charCodeAt(0) - 0x05D0;
    if (idx >= 0 && idx < machines.length) {
      return await doCollectMachine(s, machines[idx]);
    }
    return 'בחר אות מהרשימה';
  }

  // ===== הותקן =====
  if (msg === 'הותקן') {
    s.step = 'installation_confirm';
    return 'שלח צילום של התעודה החתומה 📸';
  }

  return null;
}

// ===== מה פתוח =====
async function handleWhatOpen(s, user) {
  const isManager = user.role === 'manager' || user.role === 'agent';

  // תקלות
  let ticketQuery = supabase.from('tickets')
    .select('*,customers(site_name,machine_type,location,city),technicians(name)')
    .eq('status','open').order('opened_at',{ascending:false});

  const {data: openTickets} = await ticketQuery;

  // התקנות
  const {data: openInstallations} = await supabase.from('installations')
    .select('*').is('completed_at', null).order('created_at',{ascending:false});

  let tickets = openTickets || [];
  let installations = openInstallations || [];

  if (!isManager) {
    // סנן לפי טכנאי
    const {data: tech} = await supabase.from('technicians').select('id').eq('name', user.name).single();
    if (tech) {
      tickets = tickets.filter(t => t.technician_id === tech.id);
      installations = installations.filter(i => i.technician_id === tech.id);
    }
  }

  let msg = `📋 מה פתוח — ${new Date().toLocaleDateString('he-IL')}\n\n`;

  // תקלות
  msg += `🔧 תקלות (${tickets.length}):\n`;
  if (tickets.length === 0) {
    msg += 'אין תקלות פתוחות\n';
  } else {
    tickets.forEach((t,i) => {
      const techName = t.technicians?.name || 'לא משויך';
      msg += `${i+1}. ${t.customers?.site_name||'?'} | ${t.customers?.machine_type||''} | ${t.description||''}\n`;
      msg += `   👨‍🔧 ${techName} | ⏰ ${fmtTime(t.opened_at)}\n`;
    });
  }

  // התקנות
  msg += `\n📦 התקנות (${installations.length}):\n`;
  if (installations.length === 0) {
    msg += 'אין התקנות פתוחות\n';
  } else {
    installations.forEach((inst,i) => {
      const note = inst.notes ? JSON.parse(inst.notes) : {};
      msg += `${i+1}. ${note.client_name||'?'} | ${inst.machine_type||''}\n`;
      msg += `   ⏰ ${fmtTime(inst.created_at)}\n`;
    });
  }

  // שמור רשימה לשיוך
  if (isManager) {
    s.openList = tickets;
    if (tickets.length > 0) msg += '\nלשיוך טכנאי — כתוב: שייך [מספר]';
  }

  return msg;
}

// ===== HELPERS =====
async function handleOneCustomer(s, customer, phone) {
  const machines = await getCustomerMachines(customer.site_name, s.cityName || '');
  if (machines.length > 1) {
    s.step = 'select_machine';
    s.machines = machines;
    s.faultCustomer = customer;
    const list = machines.map((m,i) =>
      `${i+1}️⃣ ${m.city || ''} | ${m.location || 'לא מצוין'} | ${m.machine_type}`
    ).join('\n');
    return `יש ${machines.length} מכונות ב${customer.site_name} — איזו?\n${list}`;
  }
  return await buildShiuach(s, customer, phone);
}

async function buildShiuach(s, machine, phone) {
  s.selectedMachine = machine;
  const hist = await getHistory(machine.site_code);
  const recent = await countRecent(machine.site_code);
  const prevTech = await getPrevTech(machine.site_code);
  const techs = await getTechnicians();

  const ticket = await openTicket(machine.site_code, machine.location, s.faultDesc, s.userName || phone);
  s.ticket = ticket;
  s.techs = techs;
  s.step = 'assign_tech_pick';

  // הודעה לאורי
  let oriMsg = `📋 תקלה חדשה\n📍 ${machine.site_name}`;
  if (machine.address) oriMsg += `\n📬 ${machine.address}`;
  if (machine.city) oriMsg += `, ${machine.city}`;
  if (machine.location) oriMsg += `\n🏢 ${machine.location}`;
  oriMsg += `\n🔧 ${machine.machine_type}`;
  oriMsg += `\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) oriMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) oriMsg += ` — ${machine.contact_phone}`;
  if (hist && hist.length > 0) {
    oriMsg += `\n\n📜 תקלות אחרונות:`;
    hist.slice(0,2).forEach(h => {
      oriMsg += `\n🔧 ${(h.closed_at||'').slice(0,10)} — ${h.actions?.join(' + ') || 'לא מצוין'}`;
    });
  }
  if (recent >= 3) oriMsg += `\n⚠️ ${recent} תקלות ב-60 יום האחרונים`;
  oriMsg += `\n\n🔧 טיפל בעבר: ${prevTech || 'לא ידוע'}`;
  oriMsg += `\n\nבחר טכנאי:\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');

  const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
  for (const p of oriPhones) await sendWhatsApp(p, oriMsg);

  // אישור מלא לשולח
  let confirmMsg = `✅ תקלה נרשמה\n\n📍 ${machine.site_name}`;
  if (machine.city) confirmMsg += `\n🏙️ ${machine.city}`;
  if (machine.address) confirmMsg += ` | 📬 ${machine.address}`;
  if (machine.location) confirmMsg += `\n🏢 ${machine.location}`;
  confirmMsg += `\n🔧 ${machine.machine_type}`;
  confirmMsg += `\n⚠️ ${s.faultDesc}`;
  if (machine.contact_name) confirmMsg += `\n👤 ${machine.contact_name}`;
  if (machine.contact_phone) confirmMsg += ` — ${machine.contact_phone}`;
  if (hist && hist.length > 0) {
    confirmMsg += `\n\n📜 תקלות אחרונות:`;
    hist.slice(0,2).forEach(h => {
      confirmMsg += `\n🔧 ${(h.closed_at||'').slice(0,10)} — ${h.actions?.join(' + ') || 'לא מצוין'}`;
    });
  }

  return confirmMsg;
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
  if (hist && hist.length > 0) {
    techMsg += `\n\n📜 תקלות אחרונות:`;
    hist.slice(0,2).forEach(h => {
      techMsg += `\n🔧 ${(h.closed_at||'').slice(0,10)} — ${h.actions?.join(' + ') || 'לא מצוין'}`;
    });
  }
  if (recent >= 3) techMsg += `\n⚠️ ${recent} תקלות ב-60 יום`;
  techMsg += `\n\nכשתסיים — כתוב: סיימתי ${machine.site_name.split(' ')[0]}`;

  // לקבוצה — broadcast לכולם
  const groupMsg = `🔧 תקלה חדשה\n📍 ${machine.site_name}${machine.location?' | '+machine.location:''}\n🔧 ${machine.machine_type}\n⚠️ ${s.faultDesc}\n👨‍🔧 שויך ל${techName}`;

  const techPhone = techPhones[techName];
  if (techPhone) await sendWhatsApp(techPhone, techMsg);
  await broadcastAll(groupMsg);

  const phone2 = s._phone;
  sessions[phone2] = { step: 'idle' };

  return `✅ שויך ל${techName}`;
}

async function doCloseTicket(s) {
  const ticket = await closeTicket(s.ticketId, s.actions, s.parts||[]);
  const siteCode = ticket?.customers?.site_code || s.siteCode;
  const hist2 = await getHistory(siteCode, 2);
  const recent = await countRecent(siteCode);

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
  const openTime = fmtTime(s.openedAt);
  const closeTime = fmtTime(new Date().toISOString());

  const hist2Text = hist2.map(h =>
    `🔧 ${(h.closed_at||'?').slice(0,10)} — ${h.actions ? h.actions.join(' + ') : 'לא מצוין'}`
  ).join('\n');

  let alerts = '';
  if (recent >= 3) alerts += `\n⚠️ ${recent} תקלות ב-60 יום`;
  const abnitCount = hist2.filter(h => h.actions?.includes('טיפול אבנית')).length;
  if (s.actions.includes('טיפול אבנית') && abnitCount >= 1) {
    alerts += '\n💧 אבנית חוזרת — שקול בדיקת מים או פילטר';
  }

  const groupMsg = `✅ ${c?.site_name||''} — ${s.closingMachine||c?.location||c?.machine_type||''}\n🔧 ${actText}${partsText}\n⏰ ${openTime} — ${closeTime}\n\n📜 2 תקלות אחרונות:\n${hist2Text||'אין היסטוריה'}${alerts}${inventoryAlerts}`;

  s.step = 'idle';
  await broadcastAll(groupMsg);
  return `✅ תקלה נסגרה\n${groupMsg}`;
}

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

  await broadcastAll(groupMsg);
  return groupMsg;
}

// ===== קריאת תמונה עם Claude API =====
async function readDeliveryNote(imageUrl) {
  const authHeader = 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
  const imgResponse = await fetch(imageUrl, { headers: { 'Authorization': authHeader } });
  const imgBuffer = await imgResponse.arrayBuffer();
  const imageData = Buffer.from(imgBuffer).toString('base64');
  const mediaType = imgResponse.headers.get('content-type') || 'image/jpeg';

  const apiKey = (process.env.ANTHROPIC_KEY || '').trim();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
          { type: 'text', text: `This is a delivery note from Mayer's Coffee. Extract the following fields as JSON only, no extra text.\n\nInstructions:\n- note_type: "איסוף" if the items table contains "סיום התקשרות" or "איסוף מכונה" in the product name, otherwise "התקנה"\n- collection_location: if note_type is "איסוף", extract the collection address/city from the product name\n- client_name: the customer name from the "לכבוד" field\n- address: the street address below the customer name\n- city: the city below the address\n- machine_type: machine model like M12, F16, F15\n- machine_quantity: the quantity number from the "כמות" column (integer)\n- contact_phone: the phone number next to "נייד"\n- contact_name: customer contact person name\n- delivery_note_number: the document number "מס'"\n- driver: driver name at the bottom\n\nReturn only this JSON:\n{ "note_type": "", "client_name": "", "address": "", "city": "", "collection_location": "", "machine_type": "", "machine_quantity": 1, "contact_name": "", "contact_phone": "", "delivery_note_number": "", "driver": "" }` }
        ]
      }]
    })
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) throw new Error('No response from Claude');
  const text = data.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ===== סיכום יומי מעבדה ב-18:00 =====
async function sendDailySummaryAlex() {
  const today = new Date();
  today.setHours(0,0,0,0);
  const {data: jobs} = await supabase.from('lab_jobs')
    .select('*').gte('started_at', today.toISOString())
    .not('completed_at', 'is', null).order('started_at');

  if (!jobs || !jobs.length) return;

  let summary = `📋 סיכום מעבדה — ${today.toLocaleDateString('he-IL')}\n\n`;
  summary += `מכונה | התחלה | סיום | פעולה | חלקים שהוחלפו\n`;
  summary += `${'─'.repeat(60)}\n`;
  jobs.forEach(j => {
    const act = j.actions ? j.actions.join(' + ') : '—';
    const parts = j.parts?.length ? j.parts.join(', ') : '—';
    const start = fmtTime(j.started_at);
    const end = fmtTime(j.completed_at);
    summary += `${j.machine_type} | ${start} | ${end} | ${act} | ${parts}\n`;
  });
  summary += `\nסה"כ: ${jobs.length} מכונות`;

  const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
  for (const p of oriPhones) await sendWhatsApp(p, summary);
  console.log('סיכום יומי מעבדה נשלח');
}

setInterval(() => {
  const now = new Date();
  if (now.getHours() === 18 && now.getMinutes() === 0) sendDailySummaryAlex();
}, 60000);

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;
    console.log(`📨 ${from}: ${body}${mediaUrl?' [תמונה]':''}`);

    if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const phone = from.replace('whatsapp:','');
      if (!sessions[phone]) sessions[phone] = {step:'idle'};
      const s = sessions[phone];

      // סגירת התקנה עם תמונה
      if (s.step === 'installation_confirm') {
        s.installationPhotoUrl = mediaUrl;
        const qty = s.installationQty || 1;
        if (qty > 1) {
          s.step = 'installation_location';
          s.installationLocations = [];
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(`מכונה 1 — באיזה מיקום הותקנה?`);
          res.type('text/xml');
          return res.send(twiml.toString());
        }
        // מכונה אחת — סיים ישירות
        await supabase.from('installations').update({
          signed_note_url: mediaUrl, completed_at: new Date().toISOString()
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
          });
        }
        s.step = 'idle';
        const groupMsg = `✅ התקנה הושלמה\n📍 ${s.pendingCustomer?.client_name||''} | ${s.pendingCustomer?.city||''}\n🔧 ${s.pendingCustomer?.machine_type||''}\n👨‍🔧 ${s.installationTech?.name||''}`;
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(groupMsg);
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // סגירת איסוף עם תמונה
      if (s.step === 'collection_photo') {
        const machinesToDeactivate = s.selectedCollectionMachines || s.collectionMachines || [];
        const qty = s.pendingCollection?.machine_quantity || 1;
        const toDeactivate = machinesToDeactivate.slice(0, qty);
        for (const machine of toDeactivate) {
          await supabase.from('customers').update({ is_active: false }).eq('id', machine.id);
        }
        const note = s.pendingCollection;
        s.step = 'idle';
        const groupMsg = `✅ איסוף הושלם\n📍 ${note?.client_name||''}\n🔧 ${toDeactivate.length} מכונות נאספו\n👨‍🔧 ${s.collectionTech?.name||''}`;
        const oriPhones = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
        for (const p of oriPhones) await sendWhatsApp(p, groupMsg);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(groupMsg);
        res.type('text/xml');
        return res.send(twiml.toString());
      }

      // תעודה חדשה מגבי
      try {
        const noteData = await readDeliveryNote(mediaUrl);
        const isCollection = noteData.note_type === 'איסוף';
        const qty = noteData.machine_quantity || 1;
        const techs = await getTechnicians();
        sessions[phone].techs = techs;

        if (isCollection) {
          const firstWord = noteData.client_name.split(' ')[0];
          const {data: allMachines} = await supabase.from('customers')
            .select('id, site_name, city, location, machine_type, site_code')
            .ilike('site_name', '%'+firstWord+'%').eq('is_active', true).limit(15);

          let existingMachines = allMachines || [];
          const filterCity = noteData.collection_location || noteData.city;
          if (filterCity && existingMachines.length > 1) {
            const filtered = existingMachines.filter(m =>
              m.city?.includes(filterCity) || filterCity?.includes(m.city) || m.site_name?.includes(filterCity)
            );
            if (filtered.length > 0) existingMachines = filtered;
          }

          // שמור בסשן של גבי
          sessions[phone].pendingCollection = noteData;
          sessions[phone].collectionMachines = existingMachines;
          sessions[phone].step = 'idle';

          let machineList = '';
          if (existingMachines.length > 0) {
            machineList = '\n\n🔧 מכונות במסד:\n' + existingMachines.map((m,i) => {
              const letter = String.fromCharCode(0x05D0 + i);
              return `${letter}) ${m.location||'לא מצוין'} | ${m.machine_type} | ${m.city}`;
            }).join('\n');
          }

          const collCard = `🔄 סיום התקשרות זוהה!\n📍 ${noteData.client_name}\n🏙️ מיקום איסוף: ${noteData.collection_location||noteData.city}\n🔧 ${noteData.machine_type} | כמות: ${qty}\n📄 תעודה: ${noteData.delivery_note_number}${machineList}\n\nבחר טכנאי:\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');

          // שמור בסשן של אורי ועודד כדי שיוכלו לבחור
          const oriPhonesC = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
          for (const oriP of oriPhonesC) {
            if (!sessions[oriP]) sessions[oriP] = {step:'idle'};
            sessions[oriP].pendingCollection = noteData;
            sessions[oriP].collectionMachines = existingMachines;
            sessions[oriP].techs = techs;
            sessions[oriP].step = 'collection_assign';
            await sendWhatsApp(oriP, collCard);
          }

          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message('✅ תעודת איסוף נקראה — נשלחה לאורי לשיוך');
          res.type('text/xml');
          return res.send(twiml.toString());
        }

        // התקנה רגילה
        const {data: existingCustomer} = await supabase.from('customers')
          .select('site_name').ilike('site_name', '%'+noteData.client_name.split(' ')[0]+'%')
          .eq('is_active', true).limit(1);
        const isNew = !existingCustomer || existingCustomer.length === 0;
        const qtyText = qty > 1 ? ` | ${qty} מכונות` : '';
        const card = `📦 התקנה חדשה!\n${isNew?'🆕 לקוח חדש':'✅ לקוח קיים'}\n📍 ${noteData.client_name}\n🏙️ ${noteData.city}\n📬 ${noteData.address}\n🔧 ${noteData.machine_type}${qtyText}\n👤 ${noteData.contact_name} — ${noteData.contact_phone}\n📄 תעודה: ${noteData.delivery_note_number}\n\nבחר טכנאי:\n` + techs.map((t,i) => `${i+1}️⃣ ${t.name}`).join('\n');

        // שמור בסשן של גבי
        sessions[phone].pendingNote = noteData;
        sessions[phone].step = 'idle';

        // שמור בסשן של אורי ועודד כדי שיוכלו לבחור טכנאי
        const oriPhonesList = [process.env.PHONE_ORI, process.env.PHONE_ODED].filter(Boolean);
        for (const oriP of oriPhonesList) {
          if (!sessions[oriP]) sessions[oriP] = {step:'idle'};
          sessions[oriP].pendingNote = noteData;
          sessions[oriP].techs = techs;
          sessions[oriP].step = 'installation_assign';
          await sendWhatsApp(oriP, card);
        }

        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('✅ תעודת התקנה נקראה — נשלחה לאורי לשיוך');
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
