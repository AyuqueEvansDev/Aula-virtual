/* EduAula — Lógica SPA (Docente / Estudiante) + Firebase Auth + Firestore */
let currentRole = 'docente';
let authMode = 'login'; // 'login' | 'register'
let session = null;
let route = 'inicio';

/* ---------- Firebase init (config que pasaste) ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyCsLdsN9UrJ3L62Q8F5V2wze6pqjtCyqx4",
  authDomain: "aulavirtual-f4839.firebaseapp.com",
  projectId: "aulavirtual-f4839",
  storageBucket: "aulavirtual-f4839.firebasestorage.app",
  messagingSenderId: "926403773678",
  appId: "1:926403773678:web:19d11e7abbcf0e1f445fff",
  measurementId: "G-FB6RD7KD93"
};
let auth = null, db = null;
try {
  if (typeof firebase !== 'undefined' && !firebase.apps.length) firebase.initializeApp(firebaseConfig);
  if (typeof firebase !== 'undefined') { auth = firebase.auth(); db = firebase.firestore(); }
} catch (e) { console.warn('Firebase no inicializó:', e); }
/* ---------- Supabase Storage (archivos: material y trabajos) ----------
   Pega aquí los datos de tu proyecto Supabase (Settings → API):
   - SUPABASE_URL: https://xyzcompany.supabase.co
   - SUPABASE_ANON_KEY: tu clave pública "anon" (es seguro exponerla en frontend)
   Crea los buckets públicos "materiales" y "trabajos" (ver instrucciones al final). */
const SUPABASE_URL = "https://cvkelvqemesaqnxchfpf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2a2VsdnFlbWVzYXFueGNoZnBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1OTAyNzcsImV4cCI6MjEwNzE2NjI3N30.iehzk5PqIsbOvrgSP9N4BvnH1J6JvONye-7X7_jD4YM";
/* Un solo bucket público "Trabajos-aula" con carpetas internas: materiales/ y trabajos/ */
const SUPA_BUCKET = "Trabajos-aula";
const SUPA_MAT_PREFIX = "materiales";
const SUPA_WORK_PREFIX = "trabajos";
let supa = null;
try {
  if (typeof supabase !== 'undefined' && SUPABASE_URL.indexOf('http') === 0)
    supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) { console.warn('Supabase no inicializó:', e); }
/* Límite de archivo: 10 MB (Supabase Storage; Firestore/localStorage no guardan binarios grandes) */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INLINE_MAX_BYTES = 2.5 * 1024 * 1024; // solo respaldo local para archivos livianos
let pendingFileHandles = []; // File objects reales para subir a Supabase
function sanitizePath(s){ return (s||'').toLowerCase().replace(/[^a-z0-9._-]+/g,'_').slice(0,80) || 'archivo'; }
/* Sube un File a Supabase Storage (bucket público) y devuelve {url, path}. Lanza error si falla. */
async function uploadFileToSupabase(bucket, path, file){
  if(!supa) throw new Error('supabase-no-configurado');
  if(file.size > MAX_FILE_BYTES) throw new Error('archivo-muy-pesado');
  const { error: upErr } = await supa.storage.from(bucket).upload(path, file, {
    contentType: file.type || mimeForExt(file.name), upsert: false
  });
  if(upErr) throw upErr;
  const { data } = supa.storage.from(bucket).getPublicUrl(path);
  if(!data || !data.publicUrl) throw new Error('sin-url-publica');
  return { url: data.publicUrl, path };
}
/* Borra archivos de Supabase (mejor esfuerzo, no bloquea). paths: array de rutas dentro del bucket. */
async function supaRemove(bucket, paths){
  try { if(supa && paths && paths.length) await supa.storage.from(bucket).remove(paths); } catch(e){}
}
let routeParam = null;
let entregaFilter = 'todos';
let entregaSearch = '';
let pendingFiles = [];

const COURSES = {
  moviles: { id:'moviles', nombre:'Desarrollo de aplicaciones móviles y videojuegos', corto:'Móviles y videojuegos', icono:'📱', desc:'Crea apps móviles y tus primeros videojuegos: diseño, lógica, pruebas y publicación.', color:'#0ea5e9' },
  ensamblaje: { id:'ensamblaje', nombre:'Ensamblaje y reparación de computadoras, redes y seguridad informática', corto:'Ensamblaje, redes y seguridad', icono:'🛠️', desc:'Ensambla y repara computadoras, configura redes y aplica seguridad informática.', color:'#f59e0b' }
};
/* Curso legacy "comp" (Computación e Informática): solo lectura para no perder datos antiguos.
   Al editar esas actividades se reasignan a uno de los dos módulos. */
const LEGACY_COURSE = { id:'comp', nombre:'Curso anterior (reasignar)', corto:'Curso anterior', icono:'📦', desc:'Actividades del curso anterior. Edítalas para moverlas a un módulo.', color:'#64748b' };
function courseOf(cid){ return COURSES[cid] || (cid === 'comp' ? LEGACY_COURSE : { id: cid||'', nombre:'Curso anterior', corto:'Curso anterior', icono:'📦', desc:'', color:'#64748b' }); }
function courseOptions(selected){
  return Object.values(COURSES).map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${c.icono} ${c.nombre}</option>`).join('')
    + ((selected && !COURSES[selected]) ? `<option value="${selected}" selected>📦 Curso anterior (reasignar)</option>` : '');
}
/* ---------- Acceso a módulos por grado y sección ----------
   - Docente: acceso total a ambos módulos.
   - Estudiante 5.º A/B: solo "Ensamblaje..."; 4.º A/B: solo "Móviles...".
   - Otro grado/sección: ambos (sin restricción definida).
   El módulo no habilitado se muestra bloqueado y no permite ver ni usar
   sus actividades, tareas, entregas ni calificaciones. */
function allowedModulesFor(u){
  if(!u || u.rol === 'docente') return Object.keys(COURSES);
  const g = (u.grado || '').trim();
  const s = (u.seccion || '').trim().toUpperCase();
  const isAB = (s === 'A' || s === 'B');
  if(isAB && /^5/.test(g)) return ['ensamblaje'];
  if(isAB && /^4/.test(g)) return ['moviles'];
  return Object.keys(COURSES);
}
function canAccessModule(cid){
  if(!cid || !COURSES[cid]) return true; // legacy u otros: se permite (migración)
  return allowedModulesFor(session).includes(cid);
}
function lockedMessage(cid){
  const c = courseOf(cid);
  const allowed = allowedModulesFor(session).map(id => courseOf(id).nombre);
  return `🔒 "${c.corto || c.nombre}" bloqueado para ${formatGradoSeccion(session) || 'tu grado y sección'}. Tu acceso: ${allowed.join(' · ') || 'ninguno'}.`;
}
function toastLocked(cid){ toast(lockedMessage(cid)); }

function formatGradoSeccion(u){
  if(!u) return '';
  if(u.grado && u.seccion) return `${u.grado} ${u.seccion}`;
  if(u.grado) return u.grado; // compatibilidad con dato antiguo "4.° B"
  return '';
}

/* ============================================================
   ESTRUCTURA LIMPIA — Módulo Actividades y Trabajos (desde cero)
   Colecciones (local + espejo Firestore opcional):
    - activities: {id, curso:'moviles'|'ensamblaje', titulo, descripcion, instrucciones,
                  material, publicacion:'YYYY-MM-DD', limite:'YYYY-MM-DD',
                  hora:'HH:MM', tipos:'.pdf,.docx', multiple:bool,
                  estado:'publicada'|'borrador', permitirTarde:bool,
                  creadoPor, creadoEn}
   - submissions: {id, activityId, estudiante, email, fecha:ISO,
                   archivo, tam, late:bool}
   En Firestore: activities/{id}, submissions/{id}, users/{uid}
   ============================================================ */
const STORE_KEY = 'eduaula_v2';
// Borra de una vez cualquier resto simulado anterior
try { localStorage.removeItem('eduaula_v1'); } catch(e){}

/* Caché en memoria: evita parsear localStorage en cada lectura (store()
   se invoca decenas de veces por render). Declarada antes de initStore
   para no caer en zona muerta temporal (TDZ). */
let _memStore = null;
function emptyStore(){
  return { activities: [], submissions: [], config: { notif:true, tarde:false, resumen:true } };
}
function initStore(){
  let d;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw){ d = emptyStore(); localStorage.setItem(STORE_KEY, JSON.stringify(d)); }
    else {
      d = JSON.parse(raw);
      // Sanea estructura por si viene corrupta
      if(!Array.isArray(d.activities)) d.activities = [];
      if(!Array.isArray(d.submissions)) d.submissions = [];
      if(!d.config) d.config = emptyStore().config;
    }
  } catch(e){
    d = emptyStore();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch(_){}
  }
  _memStore = d;
  return d;
}
function resetAllData(){
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem('eduaula_users_extra');
    localStorage.removeItem('eduaula_pwd_resets');
    localStorage.removeItem('eduaula_grade_notifs');
    localStorage.removeItem('eduaula_activity_notifs');
    localStorage.removeItem('eduaula_deleted_activities');
    localStorage.removeItem('eduaula_last_sync');
  } catch(e){}
  _memStore = null;
  initStore();
}

initStore();
function store(){
  if(_memStore) return _memStore;
  return initStore();
}
function saveStore(d){
  localStorage.setItem(STORE_KEY, JSON.stringify(d));
  _memStore = d;
}
// Si otra pestaña modifica los datos, invalida la caché local
try {
  window.addEventListener('storage', e => { if(e && e.key === STORE_KEY) _memStore = null; });
} catch(_){}

/* ---------- utils ---------- */
function deadlineOf(a){ return new Date(a.limite + 'T' + (a.hora||'23:59') + ':00'); }
function fmtFecha(iso){ if(!iso) return '—'; const d=new Date(iso.includes('T')?iso:iso+'T12:00:00'); return d.toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'}); }
function fmtFechaHora(iso){ const d=new Date(iso); return d.toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'})+' '+d.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'}); }
function fmtHora12(h){ let [H,M]=h.split(':').map(Number); const ap=H>=12?'p. m.':'a. m.'; H=H%12||12; return `${H}:${String(M).padStart(2,'0')} ${ap}`; }
function mySubmission(activityId){
  const s = store().submissions.find(x=>x.activityId===activityId && x.email===session.email);
  return s||null;
}
function statusForStudent(a, sub){
  if(a.estado==='borrador') return {key:'borrador', label:'Borrador'};
  if(sub) return sub.late ? {key:'tarde', label:'Fuera de plazo'} : {key:'presentado', label:'Presentado'};
  const diff = deadlineOf(a) - new Date();
  if(diff < 0) return {key:'vencido', label:'Vencido'};
  return {key:'pendiente', label:'Pendiente'};
}
function badge(st){
  const map={presentado:'b-green',vencido:'b-red',pendiente:'b-blue',tarde:'b-red',borrador:'b-gray',publicada:'b-green',revisar:'b-yellow'};
  const dot={presentado:'🟢',vencido:'🔴',pendiente:'🔵',tarde:'⚠️',borrador:'📝',publicada:'🟢',revisar:'🟡'};
  return `<span class="badge ${map[st.key]||'b-gray'}"><span class="dot"></span>${dot[st.key]||''} ${st.label}</span>`;
}
/* ---------- Calificaciones reales (0-20) ---------- */
function gradeOf(sub){ if(!sub || sub.grade==null || sub.grade==='' ) return null; const n=Number(sub.grade); return isNaN(n)?null:n; }
function gradeBadge(sub){
  const g = gradeOf(sub);
  if(g==null) return `<span class="badge b-gray">Sin calificar</span>`;
  const cls = g>=14 ? 'b-green' : (g>=11 ? 'b-yellow' : 'b-red');
  const ico = g>=14 ? '✅' : (g>=11 ? '🟡' : '🔴');
  return `<span class="badge ${cls}">${ico} ${g}/20</span>`;
}
/* Nombre mostrado del usuario actual, saneado para HTML. */
function displayName(){ return escHtml(session?.nombre || ''); }
function firstName(){ return escHtml((session?.nombre || '').split(' ')[0]); }
/* Promedio 0–20 de una lista de trabajos ('—' si no hay calificados). */
function avgProm(subs){
  const gs = subs.map(s=>gradeOf(s)).filter(g=>g!=null);
  if(!gs.length) return '—';
  return (gs.reduce((x,y)=>x+y,0)/gs.length).toFixed(1);
}
/* Escapa texto para interpolarlo como literal JS entre comillas simples. */
function escJs(s){
  return (s ?? '').toString().replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}
/* Abre URLs externas sin acceso a window.opener (anti tabnabbing). */
function openSafe(url){
  try { window.open(url, '_blank', 'noopener'); } catch(e){ window.open(url, '_blank'); }
}
function saveGrade(sid){
  const gEl = document.getElementById('gradeInput');
  const fEl = document.getElementById('gradeFeedback');
  if(!gEl){ return; }
  const raw = (gEl.value||'').trim();
  if(raw===''){ toast('⚠️ Escribe una nota de 0 a 20'); return; }
  const n = Number(raw);
  if(isNaN(n) || n<0 || n>20){ toast('⚠️ La nota debe estar entre 0 y 20'); return; }
  const d = store();
  const s = d.submissions.find(x=>x.id===sid);
  if(!s){ toast('⚠️ Trabajo no encontrado'); return; }
  s.grade = Math.round(n*100)/100;
  s.feedback = (fEl?.value||'').trim();
  s.gradedAt = new Date().toISOString();
  s.gradedBy = session?.email || '';
  saveStore(d);
  cloudSave('submissions', s.id, s);
  try { pushGradeNotif(s); } catch(e){ console.warn('Notif calificación falló:', e); }
  toast('✅ Calificación guardada ('+s.grade+'/20) y notificada al estudiante');
  render();
}
function clearGrade(sid){
  if(!confirm('¿Quitar la calificación de este trabajo?')) return;
  const d = store();
  const s = d.submissions.find(x=>x.id===sid);
  if(!s) return;
  s.grade = null; s.feedback=''; s.gradedAt=null; s.gradedBy='';
  saveStore(d);
  cloudSave('submissions', s.id, s);
  try {
    const arr = getGradeNotifs().filter(n => n.submissionId !== sid || n.read);
    saveGradeNotifs(arr);
  } catch(e){}
  toast('🗑 Calificación eliminada'); render();
}
/* ============================================================
   NOTIFICACIONES DE CALIFICACIÓN — avisan al estudiante cuando
   su trabajo ya fue calificado (local + espejo `grade_notifications`).
   ============================================================ */
const GRADE_NOTIF_KEY = 'eduaula_grade_notifs';
function escHtml(s){
  return (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getGradeNotifs(){
  try {
    const arr = JSON.parse(localStorage.getItem(GRADE_NOTIF_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch(e){ return []; }
}
function saveGradeNotifs(arr){
  try { localStorage.setItem(GRADE_NOTIF_KEY, JSON.stringify(arr)); } catch(e){}
}
function myGradeNotifs(){
  if(!session || session.rol !== 'estudiante') return [];
  try { syncGradeNotifsFor(session.email); } catch(e){}
  const mail = (session.email || '').toLowerCase();
  let deleted = null, valid = null;
  try { deleted = getDeletedActivityIds(); valid = validActivityIdSet(); } catch(e){}
  return getGradeNotifs()
    .filter(n => (n.studentEmail || '').toLowerCase() === mail)
    .filter(n => {
      const aid = n.activityId || '';
      if(aid && deleted && deleted.has(aid)) return false;
      if(aid && valid && valid.size && !valid.has(aid)) return false;
      return true;
    })
    .sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
}
function myUnreadGradeNotifs(){
  return myGradeNotifs().filter(n => !n.read);
}
function studentNotifCount(){
  if(!session || session.rol !== 'estudiante') return 0;
  try { return myPendingResets().length + myUnreadGradeNotifs().length + myUnreadActivityNotifs().length; }
  catch(e){ try { return myPendingResets().length; } catch(_){ return 0; } }
}
/* Crea/actualiza la notificación de un trabajo recién calificado.
   Al recalificar se reemplaza la anterior (local + nube) para que el
   estudiante vea UNA notificación nueva sin leer, no la ya leída. */
function pushGradeNotif(s){
  if(!s || gradeOf(s) == null) return;
  const act = store().activities.find(x=>x.id===s.activityId);
  const prev = getGradeNotifs().filter(n => n.submissionId === s.id);
  prev.forEach(n => cloudDelete('grade_notifications', n.id));
  const arr = getGradeNotifs().filter(n => n.submissionId !== s.id);
  const notif = {
    id: 'gn' + Date.now() + '_' + Math.floor(Math.random()*1e4),
    submissionId: s.id,
    studentEmail: (s.email || '').toLowerCase(),
    studentName: s.estudiante || '',
    activityId: s.activityId || '',
    activityTitle: act ? act.titulo : 'Actividad',
    module: act ? act.curso : '',
    grade: gradeOf(s),
    feedback: s.feedback || '',
    gradedAt: s.gradedAt || new Date().toISOString(),
    createdBy: s.gradedBy || (session?.email || ''),
    createdAt: new Date().toISOString(),
    read: false, readAt: null
  };
  arr.push(notif);
  saveGradeNotifs(arr);
  cloudSave('grade_notifications', notif.id, notif);
}
/* Genera notificaciones faltantes para calificaciones antiguas (una vez). */
function syncGradeNotifsFor(email){
  const mail = (email || '').toLowerCase();
  if(!mail) return;
  const subs = store().submissions.filter(s => (s.email||'').toLowerCase()===mail && gradeOf(s)!=null);
  if(!subs.length) return;
  let deleted = null, valid = null;
  try { deleted = getDeletedActivityIds(); valid = validActivityIdSet(); } catch(e){}
  let arr = getGradeNotifs();
  let changed = false;
  subs.forEach(s => {
    // No regenerar avisos de actividades borradas o inexistentes
    if(s.activityId && deleted && deleted.has(s.activityId)) return;
    if(s.activityId && valid && valid.size && !valid.has(s.activityId)) return;
    const exists = arr.some(n => n.submissionId === s.id);
    if(!exists){
      const act = store().activities.find(x=>x.id===s.activityId);
      arr.push({
        id: 'gn' + Date.now() + '_' + s.id,
        submissionId: s.id,
        studentEmail: mail,
        studentName: s.estudiante || '',
        activityId: s.activityId || '',
        activityTitle: act ? act.titulo : 'Actividad',
        module: act ? act.curso : '',
        grade: gradeOf(s),
        feedback: s.feedback || '',
        gradedAt: s.gradedAt || s.fecha,
        createdBy: s.gradedBy || '',
        createdAt: s.gradedAt || s.fecha,
        read: false, readAt: null
      });
      changed = true;
    }
  });
  if(changed) saveGradeNotifs(arr);
}
function markGradeNotifRead(notifId){
  const arr = getGradeNotifs();
  const n = arr.find(x => x.id === notifId);
  if(!n) return;
  if((session?.email||'').toLowerCase() !== (n.studentEmail||'').toLowerCase()){ toast('⛔ No es tu notificación.'); return; }
  n.read = true; n.readAt = new Date().toISOString();
  saveGradeNotifs(arr);
  cloudSave('grade_notifications', n.id, n);
  toast('✅ Notificación marcada como leída');
  render();
}
function markAllGradesRead(){
  if(!session || session.rol !== 'estudiante') return;
  const mail = session.email.toLowerCase();
  const arr = getGradeNotifs();
  let c = 0;
  arr.forEach(n => {
    if(n.studentEmail.toLowerCase()===mail && !n.read){ n.read = true; n.readAt = new Date().toISOString(); c++; cloudSave('grade_notifications', n.id, n); }
  });
  saveGradeNotifs(arr);
  toast(c ? `✅ ${c} notificaciones marcadas como leídas` : 'ℹ️ No tienes notificaciones pendientes');
  render();
}
/* ============================================================
   SINCRONIZACIÓN DESDE LA NUBE (multi-dispositivo)
   El docente califica en SU dispositivo y el estudiante lo ve en
   EL SUYO: el espejo Firestore es el puente. Sin esta lectura, las
   notificaciones solo existían en el localStorage del docente.
   ============================================================ */
let _lastNotifPull = 0;
async function pullGradeNotifsFromCloud(){
  if(!db || !session) return 0;
  const deleted = await fetchDeletedActivityIds().catch(() => getDeletedActivityIds());
  const isStudent = session.rol === 'estudiante';
  const mail = (session.email || '').toLowerCase();
  if(isStudent && !mail) return 0;
  // Docente: trae el espejo para verlo igual en todo dispositivo y podar
  // lo obsoleto. Estudiante: solo sus avisos.
  const snap = isStudent
    ? await db.collection('grade_notifications').where('studentEmail', '==', mail).get()
    : await db.collection('grade_notifications').limit(500).get();
  const local = getGradeNotifs();
  const byId = new Map();
  // La nube manda: parte SOLO de los docs existentes (lo borrado sale).
  snap.forEach(doc => {
    const d = Object.assign({}, doc.data() || {}, { id: doc.id });
    const aid = d.activityId || '';
    if(aid && deleted.has(aid)) return; // actividad borrada: ignorar
    const cur = local.find(n => n.id === doc.id);
    if(cur && cur.read){ d.read = true; d.readAt = d.readAt || cur.readAt; }
    else if(cur){ d.read = cur.read || false; d.readAt = cur.readAt || d.readAt || null; }
    byId.set(doc.id, d);
  });
  // Un trabajo = una notificación vigente: conserva la más reciente
  // (evita que una recalificación muestre la nota vieja además de la nueva)
  const scope = isStudent
    ? [...byId.values()].filter(n => (n.studentEmail || '').toLowerCase() === mail)
    : [...byId.values()];
  const best = new Map();
  scope.forEach(n => {
    const k = n.submissionId || n.id;
    const prev = best.get(k);
    if(!prev || (n.createdAt || '') >= (prev.createdAt || '')) best.set(k, n);
  });
  const others = isStudent ? [] : [...byId.values()].filter(n => !best.has(n.submissionId || n.id));
  let merged = [...best.values(), ...others];
  // Poda huérfanas por actividad (borradas o inexistentes con store fresco).
  try {
    const valid = validActivityIdSet();
    if(valid.size){
      merged = merged.filter(n => {
        const aid = n.activityId || '';
        if(aid && deleted.has(aid)) return false;
        if(aid && valid.has(aid)) return true;
        if(!aid){
          // Legacy sin activityId: fuera si su entrega ya no existe
          try {
            const subIds = new Set(store().submissions.map(s => s.id));
            if(n.submissionId && subIds.size && !subIds.has(n.submissionId)) return false;
          } catch(e){}
          return true;
        }
        return false;
      });
    } else {
      merged = merged.filter(n => !(n.activityId && deleted.has(n.activityId)));
    }
  } catch(e){}
  // Mantiene avisos locales de OTROS estudiantes (fuera del alcance docente
  // limitado) solo si su actividad sigue vigente.
  if(!isStudent){
    try {
      const inScope = new Set(merged.map(n => n.id));
      const valid = validActivityIdSet();
      local.forEach(n => {
        if(inScope.has(n.id)) return;
        const aid = n.activityId || '';
        if(aid && (deleted.has(aid) || (valid.size && !valid.has(aid)))) return;
        merged.push(n);
      });
    } catch(e){}
  }
  if(JSON.stringify(merged) === JSON.stringify(local)) return 0;
  saveGradeNotifs(merged);
  return 1;
}
async function pullPwdResetsFromCloud(){
  if(!db || !session || session.rol !== 'estudiante') return 0;
  const mail = (session.email || '').toLowerCase();
  if(!mail) return 0;
  const snap = await db.collection('password_resets').where('studentEmail', '==', mail).get();
  if(snap.empty) return 0;
  const local = getPwdResets();
  const byId = new Map(local.map(r => [r.id, r]));
  snap.forEach(doc => {
    const d = Object.assign({}, doc.data() || {}, { id: doc.id });
    const cur = byId.get(doc.id);
    if(!cur) byId.set(doc.id, d);
    else byId.set(doc.id, Object.assign({}, cur, d));
  });
  // Limpieza: un pendiente viejo de la nube no debe revivir si el
  // estudiante ya decidió (hay una decisión posterior en local)
  const mine = [...byId.values()].filter(r => (r.studentEmail || '').toLowerCase() === mail);
  const latestDecision = mine
    .filter(r => r.status !== 'pendiente' && r.resolvedAt)
    .sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''))[0];
  let cleaned = [...byId.values()];
  if(latestDecision){
    cleaned = cleaned.filter(r => {
      if((r.studentEmail || '').toLowerCase() !== mail) return true;
      if(r.status === 'pendiente' && (r.createdAt || '') < (latestDecision.resolvedAt || '')){
        cloudDelete('password_resets', r.id);
        return false;
      }
      return true;
    });
  }
  if(JSON.stringify(cleaned) === JSON.stringify(local)) return 0;
  savePwdResets(cleaned);
  return 1;
}
/* Trae las notificaciones de la nube y refresca si hubo cambios.
   manual=true ignora el intervalo mínimo (botón 🔄 Actualizar). */
async function pullStudentNotifs(manual){
  if(!session || session.rol !== 'estudiante') return;
  // Unifica: el botón 🔄 Actualizar ahora sincroniza TODO (actividades +
  // avisos + notas + claves), no solo notificaciones.
  return pullAllCloudData(manual);
}
/* ============================================================
   NOTIFICACIONES DE NUEVA ACTIVIDAD — avisan al estudiante en
   cualquier dispositivo cuando el docente publica (broadcast en
   colección `activity_notifications`: 1 doc por actividad).
   ============================================================ */
const ACTIVITY_NOTIF_KEY = 'eduaula_activity_notifs';
function getActivityNotifs(){
  try {
    const arr = JSON.parse(localStorage.getItem(ACTIVITY_NOTIF_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch(e){ return []; }
}
function saveActivityNotifs(arr){
  try { localStorage.setItem(ACTIVITY_NOTIF_KEY, JSON.stringify(arr)); } catch(e){}
}
function myActivityNotifs(){
  if(!session || session.rol !== 'estudiante') return [];
  let deleted = null, valid = null;
  try { deleted = getDeletedActivityIds(); valid = validActivityIdSet(); } catch(e){}
  return getActivityNotifs()
    .filter(n => canAccessModule(n.module || n.curso || ''))
    .filter(n => {
      const aid = n.activityId || (n.id || '').replace(/^an_/, '');
      if(aid && deleted && (deleted.has(aid) || deleted.has(n.id))) return false;
      if(aid && valid && valid.size && !valid.has(aid)) return false;
      return true;
    })
    .sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
}
function myUnreadActivityNotifs(){ return myActivityNotifs().filter(n => !n.read); }
function markActivityNotifRead(notifId){
  const arr = getActivityNotifs();
  const n = arr.find(x => x.id === notifId);
  if(!n) return;
  n.read = true; n.readAt = new Date().toISOString();
  saveActivityNotifs(arr);
  cloudSave('activity_notifications', n.id, n);
  toast('✅ Aviso marcado como leído');
  render();
}
function markAllActivitiesRead(){
  if(!session || session.rol !== 'estudiante') return;
  const arr = getActivityNotifs();
  let c = 0;
  arr.forEach(n => { if(!n.read && canAccessModule(n.module || '')){ n.read = true; n.readAt = new Date().toISOString(); c++; cloudSave('activity_notifications', n.id, n); } });
  saveActivityNotifs(arr);
  toast(c ? `✅ ${c} avisos marcados como leídos` : 'ℹ️ No tienes avisos pendientes');
  render();
}
/* Lápidas de borrado: propagan eliminaciones a dispositivos offline.
   Sin esto, un dispositivo con caché vieja re-subía la actividad/notif
   borrada y "resucitaba". Colección `deleted_activities/{activityId}`. */
const DELETED_ACT_KEY = 'eduaula_deleted_activities';
function getDeletedActivityIds(){
  try {
    const arr = JSON.parse(localStorage.getItem(DELETED_ACT_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch(e){ return new Set(); }
}
function saveDeletedActivityIds(setOrArr){
  try {
    const arr = setOrArr instanceof Set ? [...setOrArr] : setOrArr;
    localStorage.setItem(DELETED_ACT_KEY, JSON.stringify(arr));
  } catch(e){}
}
async function fetchDeletedActivityIds(){
  const local = getDeletedActivityIds();
  if(!db) return local;
  try {
    const snap = await db.collection('deleted_activities').get();
    snap.forEach(doc => local.add(doc.id));
    // Cada doc también puede guardar activityId explícito.
    snap.forEach(doc => { try { const d = doc.data() || {}; if(d.activityId) local.add(d.activityId); } catch(e){} });
    saveDeletedActivityIds(local);
  } catch(e){ console.warn('fetchDeletedIds falló:', e); }
  return local;
}
/* Elimina del caché local los avisos cuya actividad ya no existe o fue
   borrada. Mantiene intactos los avisos de actividades vigentes. */
function pruneOrphanActivityNotifs(validActivityIds, deletedIds){
  try {
    const local = getActivityNotifs();
    if(!local.length) return 0;
    const valid = validActivityIds instanceof Set
      ? validActivityIds
      : new Set(store().activities.map(a => a.id));
    const del = deletedIds instanceof Set ? deletedIds : getDeletedActivityIds();
    const kept = local.filter(n => {
      const aid = n.activityId || (n.id || '').replace(/^an_/, '');
      if(del.has(aid) || del.has(n.id)) return false; // borrada: fuera
      if(valid.has(aid)) return true; // vigente: se mantiene
      return false; // huérfana sin actividad: fuera (no revivir)
    });
    if(kept.length !== local.length){
      saveActivityNotifs(kept);
      return 1;
    }
  } catch(e){ console.warn('pruneOrphanActivityNotifs:', e); }
  return 0;
}
/* IDs de actividades vigentes (toda relación —entregas, avisos, notas—
   se valida contra este set por el ID único de la actividad). */
function validActivityIdSet(){
  try { return new Set(store().activities.map(a => a.id)); }
  catch(e){ return new Set(); }
}
/* Poda entregas del caché cuya actividad fue borrada o ya no existe.
   Por "ausencia" solo poda con set vigente no vacío (store sincronizado);
   las lápidas podan siempre. Nunca toca entregas de otras actividades. */
function pruneOrphanSubmissions(validIds, deletedIds){
  try {
    const d = store();
    if(!d.submissions.length) return 0;
    const valid = validIds instanceof Set ? validIds : validActivityIdSet();
    const del = deletedIds instanceof Set ? deletedIds : getDeletedActivityIds();
    const canPruneMissing = valid.size > 0;
    const kept = d.submissions.filter(s => {
      const aid = s.activityId || '';
      if(aid && del.has(aid)) return false; // actividad borrada: fuera
      if(aid && valid.has(aid)) return true; // vigente: se mantiene
      if(!aid) return true; // legacy sin activityId: no tocar aquí
      return canPruneMissing ? false : true; // huérfana: fuera (no revive)
    });
    if(kept.length !== d.submissions.length){
      d.submissions = kept;
      try { saveStore(d); } catch(e){}
      return 1;
    }
  } catch(e){ console.warn('pruneOrphanSubmissions:', e); }
  return 0;
}
/* Poda notificaciones de calificación huérfanas (localStorage). */
function pruneOrphanGradeNotifs(validIds, deletedIds){
  try {
    const local = getGradeNotifs();
    if(!local.length) return 0;
    const valid = validIds instanceof Set ? validIds : validActivityIdSet();
    const del = deletedIds instanceof Set ? deletedIds : getDeletedActivityIds();
    const canPruneMissing = valid.size > 0;
    let subIds = null;
    try { subIds = new Set(store().submissions.map(s => s.id)); } catch(e){}
    const kept = local.filter(n => {
      const aid = n.activityId || '';
      if(aid && del.has(aid)) return false;
      if(aid && valid.has(aid)) return true;
      if(aid && canPruneMissing) return false;
      // Legacy sin activityId: fuera solo si su entrega ya no existe
      if(!aid && n.submissionId && subIds && subIds.size && !subIds.has(n.submissionId)) return false;
      return true;
    });
    if(kept.length !== local.length){ saveGradeNotifs(kept); return 1; }
  } catch(e){ console.warn('pruneOrphanGradeNotifs:', e); }
  return 0;
}
/* Limpieza en Firestore de datos obsoletos (solo docente, acotada por
   sync). 1) Lápidas: aviso + entregas + notas de esas actividades. 2) Un
   barrido legacy por sesión: docs cuya actividad ya no existe. Nunca borra
   nada de actividades vigentes (todo filtrado por ID). */
let _orphanScanDone = false;
async function cleanupOrphanedCloudData(validIds, deletedIds){
  if(!db || !session || session.rol !== 'docente') return 0;
  const valid = validIds instanceof Set ? validIds : validActivityIdSet();
  const del = deletedIds instanceof Set ? deletedIds : getDeletedActivityIds();
  let cleaned = 0;
  const delIds = [...del].slice(0, 10); // acota lecturas/escrituras por sync
  async function deleteSubsByAid(aid){
    try {
      const snap = await db.collection('submissions').where('activityId', '==', aid).get();
      if(snap.empty) return;
      const paths = [];
      snap.forEach(doc => { try { const dd = doc.data() || {}; if(dd.storagePath) paths.push(dd.storagePath); } catch(e){} });
      await Promise.allSettled(snap.docs.map(x => cloudDelete('submissions', x.id)));
      cleaned++;
      if(paths.length) supaRemove(SUPA_BUCKET, paths);
    } catch(e){ console.warn('cleanup subs:', aid, e); }
  }
  async function deleteGradesByAid(aid){
    try {
      const gsnap = await db.collection('grade_notifications').where('activityId', '==', aid).get();
      if(gsnap.empty) return;
      await Promise.allSettled(gsnap.docs.map(x => cloudDelete('grade_notifications', x.id)));
      cleaned++;
    } catch(e){ console.warn('cleanup grades:', aid, e); }
  }
  for(const aid of delIds){
    try { await cloudDelete('activity_notifications', 'an_' + aid); } catch(e){}
    await deleteSubsByAid(aid);
    await deleteGradesByAid(aid);
  }
  if(cleaned) return cleaned;
  // Barrido legacy una vez por sesión (actividades ya sincronizadas).
  if(!_orphanScanDone && valid.size){
    _orphanScanDone = true;
    try {
      const allS = await db.collection('submissions').get();
      const dead = allS.docs.filter(x => { const a = (x.data() || {}).activityId || ''; return a && !valid.has(a) && !del.has(a); });
      if(dead.length){
        const paths = [];
        dead.forEach(x => { try { const dd = x.data() || {}; if(dd.storagePath) paths.push(dd.storagePath); } catch(e){} });
        await Promise.allSettled(dead.map(x => cloudDelete('submissions', x.id)));
        cleaned++;
        if(paths.length) supaRemove(SUPA_BUCKET, paths);
      }
    } catch(e){ console.warn('scan submissions:', e); }
    try {
      const allG = await db.collection('grade_notifications').get();
      const deadG = allG.docs.filter(x => { const a = (x.data() || {}).activityId || ''; return a && !valid.has(a) && !del.has(a); });
      if(deadG.length){
        await Promise.allSettled(deadG.map(x => cloudDelete('grade_notifications', x.id)));
        cleaned++;
      }
    } catch(e){ console.warn('scan grades:', e); }
    try {
      const allN = await db.collection('activity_notifications').get();
      const deadN = allN.docs.filter(x => { const dd = x.data() || {}; const a = dd.activityId || (x.id || '').replace(/^an_/, ''); return a && !valid.has(a) && !del.has(a); });
      if(deadN.length){
        await Promise.allSettled(deadN.map(x => cloudDelete('activity_notifications', x.id)));
        cleaned++;
      }
    } catch(e){ console.warn('scan notifs:', e); }
  }
  return cleaned;
}
async function pullActivityNotifsFromCloud(){
  if(!db) return 0;
  // 1) Lápidas primero: lo borrado no debe volver.
  const deleted = await fetchDeletedActivityIds().catch(() => getDeletedActivityIds());
  const snap = await db.collection('activity_notifications').get();
  const local = getActivityNotifs();
  const byId = new Map();
  // 2) La nube manda: parte SOLO de los docs que existen en la nube.
  // (Antes se partía del caché local y lo borrado nunca salía.)
  snap.forEach(doc => {
    const d = Object.assign({}, doc.data() || {}, { id: doc.id });
    const aid = d.activityId || (d.id || '').replace(/^an_/, '');
    if(deleted.has(aid) || deleted.has(d.id)) return; // borrada: ignorar
    const cur = local.find(n => n.id === doc.id);
    if(cur && cur.read){ d.read = true; d.readAt = d.readAt || cur.readAt; }
    else if(cur){ Object.assign(d, { read: cur.read || false, readAt: cur.readAt || d.readAt || null }); }
    byId.set(doc.id, d);
  });
  // 3) Filtra por actividades vigentes: si la actividad ya no existe en el
  // caché (fue eliminada y podada del store), su aviso no revive.
  let merged = [...byId.values()];
  try {
    const validActs = new Set(store().activities.map(a => a.id));
    if(validActs.size){
      merged = merged.filter(n => {
        const aid = n.activityId || (n.id || '').replace(/^an_/, '');
        if(deleted.has(aid)) return false;
        // Si la actividad existe en el store la conserva; si el store aún
        // no se sincronizó (vacío en primer arranque) no filtra de más.
        return true;
      });
    }
  } catch(e){}
  const changed = JSON.stringify(merged) !== JSON.stringify(local) ? 1 : 0;
  // 4) Poda huérfanas del caché aunque la nube venga vacía.
  const pruned = pruneOrphanActivityNotifs(null, deleted);
  if(changed || pruned){
    if(changed) saveActivityNotifs(merged);
    // Si hubo poda y también cambio, merged ya es correcto; si solo poda,
    // prune ya guardó. Si la nube está vacía y todo era huérfano, limpia.
    if(snap.empty && getActivityNotifs().length){
      const valid = new Set(store().activities.map(a => a.id));
      pruneOrphanActivityNotifs(valid, deleted);
    }
    return 1;
  }
  return 0;
}
/* Docente: crea/actualiza el aviso broadcast al publicar. Se llama
   DESPUÉS de guardar la actividad en Firestore. */
async function pushActivityBroadcast(activity){
  if(!activity || activity.estado !== 'publicada') return;
  const notif = {
    id: 'an_' + activity.id,
    activityId: activity.id,
    activityTitle: activity.titulo || 'Nueva actividad',
    module: activity.curso || '',
    descripcion: (activity.descripcion || '').slice(0, 200),
    limite: activity.limite || '',
    hora: activity.hora || '',
    createdBy: (session && session.email) || activity.creadoPor || '',
    createdAt: new Date().toISOString(),
    read: false, readAt: null
  };
  // Caché local inmediata (el docente también la ve en Notificaciones).
  const local = getActivityNotifs();
  const i = local.findIndex(n => n.id === notif.id);
  // Si ya existía y ya fue leída por este dispositivo, conserva lectura.
  if(i >= 0 && local[i].read){ notif.read = local[i].read; notif.readAt = local[i].readAt; }
  if(i >= 0) local[i] = Object.assign({}, local[i], notif, { read: local[i].read || false });
  else local.push(notif);
  saveActivityNotifs(local);
  await cloudSave('activity_notifications', notif.id, sanitizeForFirestore(notif));
}
/* Detecta actividad publicada nueva que aún no tiene aviso (respaldo por
   si el broadcast falló) y genera el aviso local + nube. NUNCA revive
   actividades borradas (respeta lápidas). */
async function detectNewActivityAlert(){
  if(!session || session.rol !== 'estudiante' || !db) return;
  try {
    const deleted = getDeletedActivityIds();
    const known = new Set(getActivityNotifs().map(n => n.activityId));
    const fresh = store().activities.filter(a =>
      a.estado === 'publicada' && !known.has(a.id) && !deleted.has(a.id) && canAccessModule(a.curso));
    for(const a of fresh.slice(0, 5)){
      await pushActivityBroadcastStudentSide(a);
    }
  } catch(e){}
}
async function pushActivityBroadcastStudentSide(a){
  try {
    if(!a || !a.id) return;
    if(getDeletedActivityIds().has(a.id)) return; // borrada: no revivir
  } catch(e){}
  const notif = {
    id: 'an_' + a.id, activityId: a.id, activityTitle: a.titulo || 'Nueva actividad',
    module: a.curso || '', descripcion: (a.descripcion || '').slice(0, 200),
    limite: a.limite || '', hora: a.hora || '',
    createdBy: a.creadoPor || '', createdAt: a.creadoEn || new Date().toISOString(),
    read: false, readAt: null
  };
  const local = getActivityNotifs();
  if(local.some(n => n.id === notif.id)) return;
  local.push(notif);
  saveActivityNotifs(local);
  try { await cloudSave('activity_notifications', notif.id, sanitizeForFirestore(notif)); } catch(e){}
}
function pendingActivityBanner(){
  let unread = [];
  try { unread = myUnreadActivityNotifs(); } catch(e){ unread = []; }
  if(!unread.length) return '';
  const n = unread[0];
  return `<div class="alert alert-blue">📚 <b>Nueva actividad publicada:</b> ${escHtml(n.activityTitle)} · ${escHtml(courseOf(n.module).corto || '')}${n.limite?` · ⏰ ${fmtFecha(n.limite)}`:''} <button class="btn btn-primary btn-sm" onclick="navigate('actividad','${n.activityId}')">Ver ahora →</button>${unread.length>1?` <small>(+${unread.length-1} más)</small>`:''}</div>`;
}
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
/* ============================================================
   DESCARGAS CORRECTAS — preserva bytes reales + genera
   archivos Office válidos (OOXML) cuando no hay contenido.
   Causa del bug anterior: se descargaba un Blob text/plain
   con extensión .docx/.xlsx/.pptx -> "error de contenido".
   ============================================================ */
function mimeForExt(name){
  const ext = ('.' + (name||'').split('.').pop()).toLowerCase();
  const map = {
    '.txt':'text/plain;charset=utf-8', '.csv':'text/csv;charset=utf-8', '.html':'text/html;charset=utf-8',
    '.pdf':'application/pdf',
    '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt':'application/vnd.ms-powerpoint', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
    '.zip':'application/zip'
  };
  return map[ext] || 'application/octet-stream';
}
function crc32js(buf){
  let t = crc32js._t;
  if(!t){ t = crc32js._t = new Int32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c; } }
  let c = -1; for(let i=0;i<buf.length;i++) c = t[(c^buf[i])&255]^(c>>>8);
  return (c^-1)>>>0;
}
function zipStoreBrowser(files){
  // ZIP con método STORED (sin compresión): válido para Word/Excel/PowerPoint
  const enc = new TextEncoder();
  const parts = []; const central = []; let off = 0;
  for(const [name, str] of files){
    const data = enc.encode(str); const crc = crc32js(data); const n = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, n.length, true);
    parts.push(new Uint8Array(lh.buffer), n, data);
    central.push({ n, data, crc, off }); off += 30 + n.length + data.length;
  }
  const cdStart = off; const cdParts = [];
  for(const e of central){
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true);
    h.setUint32(16, e.crc, true); h.setUint32(20, e.data.length, true); h.setUint32(24, e.data.length, true);
    h.setUint16(28, e.n.length, true); h.setUint32(42, e.off, true);
    cdParts.push(new Uint8Array(h.buffer), e.n);
  }
  let cdLen = 0; cdParts.forEach(p => cdLen += p.length);
  const cd = new Uint8Array(cdLen); let p0 = 0; cdParts.forEach(p => { cd.set(p, p0); p0 += p.length; });
  let bodyLen = 0; parts.forEach(p => bodyLen += p.length);
  const out = new Uint8Array(bodyLen + cdLen + 22); let o = 0;
  parts.forEach(p => { out.set(p, o); o += p.length; });
  out.set(cd, o); o += cdLen;
  const dv = new DataView(out.buffer, o, 22);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true); dv.setUint16(10, central.length, true);
  dv.setUint32(12, cdLen, true); dv.setUint32(16, cdStart, true);
  return out;
}
function validOfficeBytes(ext, title){
  const safe = (title||'EduAula').slice(0,60);
  if(ext === '.pdf'){
    const txt = `BT /F1 14 Tf 50 750 Td (EduAula - ${safe}) Tj ET`;
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n4 0 obj<</Length ${txt.length}>>stream\n${txt}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n`;
    return { bytes: new TextEncoder().encode(pdf), mime: 'application/pdf' };
  }
  if(ext === '.docx' || ext === '.docm'){
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>EduAula - ${safe}. Este documento se abre correctamente en Word.</w:t></w:r></w:p></w:body></w:document>`;
    return { bytes: zipStoreBrowser([['[Content_Types].xml',ct],['_rels/.rels',rels],['word/document.xml',doc]]), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if(ext === '.xlsx' || ext === '.xlsm'){
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbrel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>EduAula - ${safe}</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Archivo valido de Excel</t></is></c></row></sheetData></worksheet>`;
    return { bytes: zipStoreBrowser([['[Content_Types].xml',ct],['_rels/.rels',rels],['xl/workbook.xml',wb],['xl/_rels/workbook.xml.rels',wbrel],['xl/worksheets/sheet1.xml',sheet]]), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if(ext === '.pptx'){
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
    const pres = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst></p:presentation>';
    const presrel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
    const master = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldMaster>';
    const layout = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent" preserve="1"><p:cSld name="Titulo"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>';
    const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Titulo"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>EduAula - ${safe}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    return { bytes: zipStoreBrowser([['[Content_Types].xml',ct],['_rels/.rels',rels],['ppt/presentation.xml',pres],['ppt/_rels/presentation.xml.rels',presrel],['ppt/slideMasters/slideMaster1.xml',master],['ppt/slideLayouts/slideLayout1.xml',layout],['ppt/slides/slide1.xml',slide]]), mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }
  return null;
}
function saveBlob(bytes, mime, name){
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const u = URL.createObjectURL(blob);
  const l = document.createElement('a'); l.href = u; l.download = name || 'archivo';
  document.body.appendChild(l); l.click(); l.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}
function dataUrlToBytes(dataUrl){
  const parts = dataUrl.split(','); const b64 = parts[1] || '';
  const bin = atob(b64); const len = bin.length;
  const bytes = new Uint8Array(len);
  for(let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
/* Descarga: 1) URL de Supabase (original) 2) bytes locales 3) archivo válido generado. */
function downloadFile(name){
  if(!name){ toast('⚠️ Archivo no encontrado'); return; }
  try {
    const d = store();
    let found = d.submissions.find(s => s.archivo === name && (s.fileUrl || s.dataUrl));
    if(!found) found = d.submissions.find(s => s.archivo === name);
    let matAct = null;
    if(!found) matAct = d.activities.find(a => a.material === name && (a.materialUrl || a.materialData));
    if(!matAct && !found) matAct = d.activities.find(a => a.material === name);
    if(found && found.fileUrl){ openSafe(found.fileUrl); return; }
    if(matAct && matAct.materialUrl){ openSafe(matAct.materialUrl); return; }
    if(found && found.dataUrl){
      saveBlob(dataUrlToBytes(found.dataUrl), found.mime || mimeForExt(name), name);
      return;
    }
    if(matAct && matAct.materialData){
      saveBlob(dataUrlToBytes(matAct.materialData), matAct.materialMime || mimeForExt(name), name);
      return;
    }
    const ext = ('.' + name.split('.').pop()).toLowerCase();
    const valid = validOfficeBytes(ext, name.replace(/\.[^.]+$/, ''));
    if(valid){ saveBlob(valid.bytes, valid.mime, name); return; }
    const blob = new Blob(['EduAula\nArchivo: ' + name + '\nGenerado como respaldo.'], { type: mimeForExt(name) });
    saveBlob(blob, mimeForExt(name), name);
  } catch(e){ console.error(e); toast('⚠️ No se pudo descargar'); }
}
function downloadSubmission(sid){
  const s = store().submissions.find(x => x.id === sid);
  if(!s){ toast('⚠️ Trabajo no encontrado'); return; }
  if(s.fileUrl){ openSafe(s.fileUrl); return; } // original en Supabase
  if(s.dataUrl){
    try { saveBlob(dataUrlToBytes(s.dataUrl), s.mime || mimeForExt(s.archivo), s.archivo); return; }
    catch(e){ console.warn(e); }
  }
  downloadFile(s.archivo);
}
function downloadMaterial(activityId){
  const a = store().activities.find(x => x.id === activityId);
  if(!a || !a.material){ toast('⚠️ Sin material'); return; }
  if(a.materialUrl){ openSafe(a.materialUrl); return; } // original en Supabase
  if(a.materialData){
    try { saveBlob(dataUrlToBytes(a.materialData), a.materialMime || mimeForExt(a.material), a.material); return; }
    catch(e){ console.warn(e); }
  }
  downloadFile(a.material);
}
function readFileAsDataUrl(file){
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

/* ---------- auth (Firebase + demo fallback) ---------- */
function togglePassword(){
  const inp = document.getElementById('loginPass');
  const btn = document.querySelector('.pass-toggle');
  if(!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  if(btn) btn.textContent = show ? '🙈' : '👁️';
  inp.focus();
}
function updateGradeVisibility(){
  const show = authMode === 'register' && currentRole === 'estudiante';
  const row = document.getElementById('regGradeRow');
  if(row) row.style.display = show ? '' : 'none';
}
function switchRole(r){
  currentRole=r;
  document.getElementById('roleDocente').classList.toggle('active',r==='docente');
  document.getElementById('roleEstudiante').classList.toggle('active',r==='estudiante');
  document.getElementById('roleDocente')?.setAttribute('aria-pressed', r==='docente' ? 'true' : 'false');
  document.getElementById('roleEstudiante')?.setAttribute('aria-pressed', r==='estudiante' ? 'true' : 'false');
  // Animación al cambiar de rol
  const card = document.querySelector('.login-card');
  if(card){ card.classList.remove('switch-anim'); void card.offsetWidth; card.classList.add('switch-anim'); }
  if (authMode === 'login') {
    document.getElementById('loginEmail').value = '';
  }
  updateGradeVisibility();
}
function toggleAuthMode(mode){
  authMode = mode;
  const isReg = mode === 'register';
  document.getElementById('regNameField').style.display = isReg ? '' : 'none';
  document.getElementById('btnLogin').style.display = isReg ? 'none' : '';
  document.getElementById('btnRegister').style.display = isReg ? '' : 'none';
  document.getElementById('toRegister').style.display = isReg ? 'none' : '';
  document.getElementById('toLogin').style.display = isReg ? '' : 'none';
  document.getElementById('authTitle').textContent = isReg ? 'Crear cuenta' : 'Iniciar sesión';
  document.getElementById('authSub').textContent = isReg
    ? 'Regístrate como docente o estudiante. Se guardará en Firebase.'
    : 'Accede según tu rol: docente o estudiante.';
  document.getElementById('passHint').textContent = isReg
    ? 'Mínimo 6 caracteres (lo exige Firebase).'
    : 'Firebase: usa tu contraseña real registrada.';
  updateGradeVisibility();
  hideAuthError();
}
function showAuthError(msg){
  const b = document.getElementById('authError');
  if(!b){ toast(msg); return; }
  b.textContent = msg; b.style.display = '';
}
function hideAuthError(){
  const b = document.getElementById('authError');
  if(b){ b.style.display = 'none'; b.textContent = ''; }
}
function friendlyAuthError(err){
  if(!err || !err.code) return 'Error de autenticación.';
  const map = {
    'auth/email-already-in-use': '⚠️ Ese correo ya está registrado. Inicia sesión.',
    'auth/invalid-email': '⚠️ Correo no válido.',
    'auth/weak-password': '⚠️ Contraseña muy débil (mínimo 6 caracteres).',
    'auth/user-not-found': '⚠️ No existe una cuenta con ese correo. Regístrate.',
    'auth/wrong-password': '⚠️ Contraseña incorrecta.',
    'auth/invalid-credential': '⚠️ Correo o contraseña incorrectos.',
    'auth/too-many-requests': '⚠️ Demasiados intentos. Espera un momento.',
    'auth/network-request-failed': '⚠️ Sin conexión a Firebase. Revisa tu internet.',
    'auth/operation-not-allowed': '⚠️ Habilita Email/Password en Firebase Console → Authentication → Sign-in method.'
  };
  return map[err.code] || ('⚠️ ' + (err.message || 'Error de Firebase.'));
}

// Registro real en Firebase Auth + guarda perfil en Firestore users/{uid}
async function doRegister(){
  hideAuthError();
  const nombre = (document.getElementById('regName').value || '').trim();
  const email = (document.getElementById('loginEmail').value || '').trim();
  const pass = document.getElementById('loginPass').value || '';
  const grado = (document.getElementById('regGrado')?.value || '').trim();
  const seccion = (document.getElementById('regSeccion')?.value || '').trim();
  if(!nombre){ showAuthError('⚠️ Escribe tu nombre completo.'); return; }
  if(!email){ showAuthError('⚠️ Escribe tu correo.'); return; }
  if(pass.length < 6){ showAuthError('⚠️ La contraseña debe tener al menos 6 caracteres.'); return; }
  if(currentRole === 'estudiante'){
    if(!grado){ showAuthError('⚠️ Selecciona tu grado.'); return; }
    if(!seccion){ showAuthError('⚠️ Selecciona tu sección.'); return; }
  }
  if(!auth || !db){ showAuthError('⚠️ Firebase no cargó. Revisa tu conexión.'); return; }
  const btn = document.getElementById('btnRegister');
  btn.disabled = true; btn.textContent = 'Creando cuenta…';
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    const uid = cred.user.uid;
    const perfil = {
      nombre, email: email.toLowerCase(), rol: currentRole,
      grado: currentRole === 'estudiante' ? grado : '',
      seccion: currentRole === 'estudiante' ? seccion : '',
      curso: currentRole === 'docente' ? '2 módulos' : '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('users').doc(uid).set(perfil);
    await cred.user.updateProfile({ displayName: nombre });
    rememberExtraUser(perfil);
    enterApp({ nombre, email: perfil.email, rol: currentRole, grado: perfil.grado, seccion: perfil.seccion, curso: perfil.curso, uid });
    toast('✨ Cuenta creada. ¡Bienvenido/a!');
  } catch (err) { console.error(err); showAuthError(friendlyAuthError(err)); }
  finally { btn.disabled = false; btn.textContent = 'Crear cuenta ✨'; }
}

// Login real en Firebase Auth + lee perfil de Firestore + VALIDA ROL
async function doLogin(){
  hideAuthError();
  const email = (document.getElementById('loginEmail').value || '').trim();
  const pass = document.getElementById('loginPass').value || '';
  if(!email || !pass){ showAuthError('⚠️ Escribe correo y contraseña.'); return; }
  if(!auth || !db){
    // Sin Firebase (offline): entra en modo local con validación de rol en caché
    return demoLogin(currentRole, email);
  }
  const btn = document.getElementById('btnLogin');
  btn.disabled = true; btn.textContent = 'Verificando…';
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    const uid = cred.user.uid;
    const snap = await db.collection('users').doc(uid).get();
    const perfil = snap.exists ? snap.data() : null;
    if(!perfil){
      // Cuenta de Auth sin ficha en Firestore: no se puede determinar su rol -> no entrar
      try { await auth.signOut(); } catch(e){}
      showAuthError('⚠️ Esta cuenta no tiene rol asignado. Regístrate de nuevo seleccionando Docente o Estudiante.');
      return;
    }
    // VALIDACIÓN ESTRICTA DE ROL: el rol elegido debe coincidir con el registrado
    if(perfil.rol !== currentRole){
      try { await auth.signOut(); } catch(e){}
      if(perfil.rol === 'docente')
        showAuthError('⛔ Esta cuenta es de DOCENTE. Selecciona el rol “Docente” para ingresar.');
      else
        showAuthError('⛔ Esta cuenta es de ESTUDIANTE. Selecciona el rol “Estudiante” para ingresar.');
      return;
    }
    rememberExtraUser(perfil);
    enterApp({ nombre: perfil.nombre, email: perfil.email, rol: perfil.rol, grado: perfil.grado || '', seccion: perfil.seccion || '', curso: perfil.curso || '', uid });
  } catch (err) { console.error(err); showAuthError(friendlyAuthError(err)); }
  finally { btn.disabled = false; btn.textContent = 'Ingresar →'; }
}

// Guarda usuarios registrados localmente (caché del roster real de Firestore)
function rememberExtraUser(perfil){
  try {
    const key = 'eduaula_users_extra';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    const i = arr.findIndex(u => u.email.toLowerCase() === perfil.email.toLowerCase());
    const row = { nombre: perfil.nombre, email: perfil.email.toLowerCase(), grado: perfil.grado || '', seccion: perfil.seccion || '', rol: perfil.rol };
    if(i >= 0) arr[i] = row; else arr.push(row);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch(e){}
}
// Roster REAL: registrados + quienes ya presentaron trabajos. Sin simulados.
function getAllStudents(){
  let extra = [];
  try {
    extra = JSON.parse(localStorage.getItem('eduaula_users_extra') || '[]').filter(u => u.rol === 'estudiante');
  } catch(e){}
  const map = new Map();
  extra.forEach(s => { if(s.email && !map.has(s.email.toLowerCase())) map.set(s.email.toLowerCase(), s); });
  // Incluye también a quienes aparecen solo en trabajos (por si se borró el caché)
  try {
    store().submissions.forEach(s => {
      if(s.email && !map.has(s.email.toLowerCase()))
        map.set(s.email.toLowerCase(), { nombre: s.estudiante || s.email.split('@')[0], email: s.email.toLowerCase(), grado:'', seccion:'', rol:'estudiante' });
    });
  } catch(e){}
  return [...map.values()];
}

/* ============================================================
   MÓDULO GESTIÓN DE ESTUDIANTES — credenciales y notificaciones
   - Firebase Auth NO permite leer la contraseña real (hash).
     Por eso el docente visualiza la CONTRASEÑA TEMPORAL asignada
     al restablecer, nunca la original.
   - Flujo: docente genera temporal → se guarda reset pendiente
     (local + espejo Firestore `password_resets`) → el estudiante
     recibe notificación y decide: conservar temporal o crear nueva.
   ============================================================ */
const PWD_RESET_KEY = 'eduaula_pwd_resets';
function getPwdResets(){
  try {
    const arr = JSON.parse(localStorage.getItem(PWD_RESET_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch(e){ return []; }
}
function savePwdResets(arr){
  try { localStorage.setItem(PWD_RESET_KEY, JSON.stringify(arr)); } catch(e){}
}
function getResetsFor(email){
  const mail = (email || '').toLowerCase();
  return getPwdResets()
    .filter(r => (r.studentEmail || '').toLowerCase() === mail)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function getLatestReset(email){
  const list = getResetsFor(email);
  return list.length ? list[0] : null;
}
function getPendingReset(email){
  return getResetsFor(email).find(r => r.status === 'pendiente') || null;
}
function myPendingResets(){
  if(!session || session.rol !== 'estudiante') return [];
  return getResetsFor(session.email).filter(r => r.status === 'pendiente')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
function docentePendingCount(){
  return getPwdResets().filter(r => r.status === 'pendiente').length;
}
function genTempPassword(){
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for(let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `Aula-${n}-${s}`; // ej. Aula-4821-XyZq (>=6, legible)
}
function toggleTempPwd(resetId){
  const el = document.getElementById('pwd_' + resetId);
  if(!el) return;
  const real = el.dataset.pwd || '';
  const hidden = el.dataset.hidden === '1';
  if(hidden){ el.textContent = real; el.dataset.hidden = '0'; }
  else { el.textContent = '••••••••'; el.dataset.hidden = '1'; }
  const btn = document.getElementById('eye_' + resetId);
  if(btn) btn.textContent = hidden ? '🙈' : '👁️';
}
function copyTempPwd(text){
  try {
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>toast('📋 Contraseña copiada'), ()=>toast('⚠️ No se pudo copiar'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); toast('📋 Contraseña copiada');
    }
  } catch(e){ toast('⚠️ No se pudo copiar'); }
}
/* Docente restablece: genera temporal + crea notificación pendiente. */
function resetStudentPassword(email){
  if(!session || session.rol !== 'docente'){ toast('⛔ Solo el docente puede restablecer.'); return; }
  const all = getAllStudents();
  const st = all.find(s => s.email.toLowerCase() === (email || '').toLowerCase());
  if(!st){ toast('⚠️ Estudiante no encontrado'); return; }
  const pending = getPendingReset(st.email);
  if(pending && !confirm(`"${st.nombre}" ya tiene una temporal pendiente (${pending.tempPassword}). ¿Generar una nueva y reemplazarla?`)) return;
  if(!pending && !confirm(`¿Restablecer la contraseña de ${st.nombre} (${st.email})?\nSe generará una temporal y se le notificará.`)) return;
  const temp = genTempPassword();
  const prevPend = getPwdResets().filter(r => r.studentEmail.toLowerCase() === st.email.toLowerCase() && r.status === 'pendiente');
  prevPend.forEach(r => cloudDelete('password_resets', r.id));
  const arr = getPwdResets().filter(r => !(r.studentEmail.toLowerCase() === st.email.toLowerCase() && r.status === 'pendiente'));
  const reset = {
    id: 'pr' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
    studentEmail: st.email.toLowerCase(),
    studentName: st.nombre,
    grado: st.grado || '', seccion: st.seccion || '',
    tempPassword: temp,
    status: 'pendiente', decision: null,
    createdBy: session.email || '', createdAt: new Date().toISOString(),
    resolvedAt: null
  };
  arr.push(reset);
  savePwdResets(arr);
  cloudSave('password_resets', reset.id, reset);
  toast('🔑 Temporal generada y notificada al estudiante');
  render();
}
/* Estudiante decide: 'conservar' la temporal o 'nueva' personalizada. */
async function studentResolveReset(resetId, mode){
  const arr = getPwdResets();
  const r = arr.find(x => x.id === resetId);
  if(!r){ toast('⚠️ Notificación no encontrada'); return; }
  if((session?.email || '').toLowerCase() !== (r.studentEmail || '').toLowerCase()){
    toast('⛔ Esta notificación no es tuya.'); return;
  }
  if(r.status !== 'pendiente'){ toast('ℹ️ Ya decidiste sobre esta contraseña.'); return; }
  let finalPwd = r.tempPassword;
  if(mode === 'nueva'){
    const inp = document.getElementById('newPwd_' + resetId);
    const val = (inp?.value || '').trim();
    if(val.length < 6){ toast('⚠️ La nueva contraseña debe tener al menos 6 caracteres'); inp?.focus(); return; }
    finalPwd = val;
  } else {
    if(!confirm(`¿Conservar la temporal "${r.tempPassword}" como tu contraseña?`)) return;
  }
  // Intenta aplicarla en Firebase Auth (requiere sesión reciente del propio estudiante)
  let applied = false;
  try {
    if(auth && auth.currentUser && auth.currentUser.email &&
       auth.currentUser.email.toLowerCase() === r.studentEmail.toLowerCase()){
      await auth.currentUser.updatePassword(finalPwd);
      applied = true;
    }
  } catch(e){
    console.warn('updatePassword falló (se guarda la decisión igual):', e);
  }
  r.status = (mode === 'nueva') ? 'personalizada' : 'conservada';
  r.decision = (mode === 'nueva') ? 'nueva' : 'conservar';
  r.resolvedAt = new Date().toISOString();
  r.appliedInAuth = applied;
  if(mode === 'nueva') r.tempPassword = '•••••• (personalizada)';
  savePwdResets(arr);
  cloudSave('password_resets', r.id, r);
  toast(mode === 'nueva'
    ? (applied ? '✅ Nueva contraseña creada y aplicada' : '✅ Decisión guardada: usarás tu nueva contraseña (vuelve a ingresar con ella)')
    : (applied ? '✅ Contraseña temporal conservada y aplicada' : '✅ Decisión guardada: conservarás la temporal'));
  render();
}
/* Reenviar / marcar pendiente de nuevo (docente). */
function resendReset(resetId){
  const arr = getPwdResets();
  const r = arr.find(x => x.id === resetId);
  if(!r) return;
  r.status = 'pendiente'; r.decision = null; r.resolvedAt = null;
  savePwdResets(arr);
  cloudSave('password_resets', r.id, r);
  toast('📨 Notificación reenviada al estudiante');
  render();
}

/* ---------- Nube Firestore como FUENTE DE VERDAD (multi-dispositivo) ----------
   Antes: localStorage era la única fuente para activities/submissions y
   Firestore solo un espejo de escritura. El estudiante en otro dispositivo
   nunca veía lo creado por el docente. Ahora:
   - Toda escritura va a Firestore (await, con error visible).
   - Al iniciar sesión se hace PULL completo y se suscribe onSnapshot
     (tiempo real): cualquier actividad publicada aparece sola, sin recargar.
   - localStorage queda SOLO como caché offline, nunca como verdad. */
function sanitizeForFirestore(obj){
  // Firestore rechaza `undefined` y valores enormes (dataUrl). Limpia.
  try {
    const clean = JSON.parse(JSON.stringify(obj, (k, v) => (v === undefined ? null : v)));
    return clean;
  } catch(e){ return obj; }
}
function cloudSave(collection, id, data){
  try {
    if(!db) return Promise.resolve(false);
    const clean = sanitizeForFirestore(data);
    return db.collection(collection).doc(id).set(clean, { merge:true })
      .then(()=>true)
      .catch(e=>{ console.warn('Cloud save '+collection+' falló:', e); return false; });
  } catch(e){ return Promise.resolve(false); }
}
function cloudDelete(collection, id){
  try {
    if(!db) return Promise.resolve(false);
    return db.collection(collection).doc(id).delete().catch(()=>false).then(()=>true);
  } catch(e){ return Promise.resolve(false); }
}
/* Estado de conexión con Firebase (para UI y diagnóstico). */
let _cloudStatus = 'desconocido'; // 'conectado' | 'sin-conexion' | 'error-permisos'
async function checkFirebaseConnection(){
  if(!db){
    _cloudStatus = 'sin-conexion';
    return { ok:false, reason:'sdk-no-cargado' };
  }
  try {
    // Lectura barata para verificar reglas/conectividad.
    await db.collection('activities').limit(1).get();
    _cloudStatus = 'conectado';
    return { ok:true };
  } catch(e){
    console.warn('checkFirebaseConnection:', e);
    _cloudStatus = (e && e.code === 'permission-denied') ? 'error-permisos' : 'sin-conexion';
    return { ok:false, reason: e && e.code ? e.code : (e && e.message) || 'desconocido', error: e };
  }
}
/* --- PULL: trae todo lo compartido y lo fusiona al caché local --- */
let _lastCloudPull = 0;
let _lastFullSyncAt = '';
try { _lastFullSyncAt = localStorage.getItem('eduaula_last_sync') || ''; } catch(e){}
function markFullSync(){
  _lastCloudPull = Date.now();
  _lastFullSyncAt = new Date().toISOString();
  try { localStorage.setItem('eduaula_last_sync', _lastFullSyncAt); } catch(e){}
}
/* Actividades: la nube manda. Fusiona por id (nube gana), poda borradas
   y NO resucita: solo re-sube creaciones offline genuinamente nuevas. */
async function pullActivitiesFromCloud(){
  if(!db) return 0;
  const deleted = await fetchDeletedActivityIds().catch(() => getDeletedActivityIds());
  const snap = await db.collection('activities').get();
  const d = store();
  const cloudById = new Map();
  snap.forEach(doc => {
    if(deleted.has(doc.id)) return; // lápida: ignorar doc zombie
    cloudById.set(doc.id, Object.assign({}, doc.data() || {}, { id: doc.id }));
  });
  let changed = 0;
  // Nuevas / actualizadas desde la nube (sobrescriben caché vieja).
  const nextById = new Map();
  cloudById.forEach((cloud, id) => {
    const local = d.activities.find(a => a.id === id);
    if(!local || JSON.stringify(local) !== JSON.stringify(cloud)) changed++;
    nextById.set(id, cloud);
  });
  // Locales que la nube no trae:
  const cloudIds = new Set(cloudById.keys());
  const lastSync = _lastFullSyncAt || '';
  d.activities.forEach(a => {
    if(cloudIds.has(a.id) || deleted.has(a.id)) return; // vigente o borrada
    // ¿Creación offline nueva (posterior a la última sync)? Re-súbela.
    // ¿Resto viejo que falta en la nube? Fue borrado en otro dispositivo:
    // NO lo re-subas, depúralo del caché.
    const created = a.creadoEn || a.actualizadoEn || '';
    const isFresh = lastSync && created && created >= lastSync;
    if(isFresh && !deleted.has(a.id)){
      nextById.set(a.id, a);
      try { cloudSave('activities', a.id, stripHeavy(a)); } catch(e){}
    } else {
      changed++; // se poda del caché (estaba borrada en la nube)
    }
  });
  const merged = [...nextById.values()];
  if(changed || merged.length !== d.activities.length){
    d.activities = merged;
    try { saveStore(d); } catch(e){}
    // Al podar actividades, podar también sus avisos huérfanos.
    try { pruneOrphanActivityNotifs(new Set(merged.map(a => a.id)), deleted); } catch(e){}
    return 1;
  }
  return 0;
}
function stripHeavy(o){
  const lite = Object.assign({}, o);
  // No subir dataUrls gigantes a Firestore (límite 1MB por doc).
  if(lite.materialData && lite.materialData.length > 900000) delete lite.materialData;
  if(lite.dataUrl && lite.dataUrl.length > 900000) delete lite.dataUrl;
  return sanitizeForFirestore(lite);
}
/* Entregas: docente trae todo; estudiante solo las suyas (ahorra lecturas). */
async function pullSubmissionsFromCloud(){
  if(!db || !session) return 0;
  const deleted = await fetchDeletedActivityIds().catch(() => getDeletedActivityIds());
  let snap;
  if(session.rol === 'estudiante'){
    const mail = (session.email || '').toLowerCase();
    if(!mail) return 0;
    // Algunas entregas viejas guardaron email con mayúsculas: trae por
    // el correo exacto y filtra insensible a mayúsculas en memoria.
    snap = await db.collection('submissions').where('email', '==', session.email).get();
    if(snap.empty && session.email !== mail){
      snap = await db.collection('submissions').where('email', '==', mail).get();
    }
  } else {
    snap = await db.collection('submissions').get();
  }
  const d = store();
  const cloudIds = new Set(snap.docs.map(x => x.id));
  const byId = new Map();
  let changed = 0;
  // La nube manda: parte SOLO de los docs existentes (lo borrado sale).
  snap.forEach(doc => {
    const cloud = Object.assign({}, doc.data() || {}, { id: doc.id });
    const aid = cloud.activityId || '';
    if(aid && deleted.has(aid)) return; // actividad borrada: ignorar doc zombie
    const local = d.submissions.find(s => s.id === doc.id);
    if(local && JSON.stringify(local) !== JSON.stringify(cloud)) changed++;
    else if(!local) changed++;
    byId.set(doc.id, cloud);
  });
  // Locales que la nube no trae: re-sube solo creaciones offline frescas;
  // el resto estaba borrado en otro dispositivo → se poda (no revive).
  const lastSync = _lastFullSyncAt || '';
  d.submissions.forEach(s => {
    if(byId.has(s.id)) return;
    if((s.activityId && deleted.has(s.activityId))) { changed++; return; }
    const created = s.fecha || s.actualizadoEn || '';
    const isFresh = lastSync && created && created >= lastSync;
    if(isFresh){
      byId.set(s.id, s);
      try { const lite = Object.assign({}, s); if(lite.dataUrl && lite.dataUrl.length > 900000) delete lite.dataUrl; cloudSave('submissions', s.id, lite); } catch(e){}
    } else { changed++; }
  });
  let merged = [...byId.values()];
  if(session.rol === 'estudiante'){
    // Conserva solo mis entregas (evita ver las de otros por caché vieja).
    merged = merged.filter(s => ((s.email || '').toLowerCase() === (session.email || '').toLowerCase()));
  }
  // Poda huérfanas por actividad (tombstones + actividades inexistentes).
  try {
    const valid = validActivityIdSet();
    const before = merged.length;
    merged = merged.filter(s => {
      const aid = s.activityId || '';
      if(aid && deleted.has(aid)) return false;
      if(aid && valid.has(aid)) return true;
      if(!aid) return true;
      return valid.size ? false : true;
    });
    if(merged.length !== before) changed++;
  } catch(e){}
  const prevLen = d.submissions.length;
  if(changed || merged.length !== prevLen){
    d.submissions = merged;
    try { saveStore(d); } catch(e){}
    return 1;
  }
  return 0;
}
/* Sincronización total post-login + botón Actualizar.
   Orden importa: lápidas → actividades → avisos (para podar huérfanas
   con el store ya actualizado). Las vigentes se mantienen intactas. */
async function pullAllCloudData(manual){
  if(!session) return;
  if(!db){ if(manual) toast('⚠️ Sin conexión a la nube. Revisa tu internet.'); return; }
  const now = Date.now();
  if(!manual && now - _lastCloudPull < 15000) return;
  _lastCloudPull = now;
  if(manual) toast('🔄 Sincronizando con la nube…');
  try {
    let changed = 0;
    try { changed += await pullActivitiesFromCloud() ? 1 : 0; } catch(e){ console.warn('pull activities:', e); }
    try { changed += await pullSubmissionsFromCloud() ? 1 : 0; } catch(e){ console.warn('pull submissions:', e); }
    try { changed += await pullActivityNotifsFromCloud() ? 1 : 0; } catch(e){ console.warn('pull actNotifs:', e); }
    try { changed += await pullGradeNotifsFromCloud().catch(()=>0) ? 1 : 0; } catch(e){}
    try { changed += await pullPwdResetsFromCloud().catch(()=>0) ? 1 : 0; } catch(e){}
    // Poda final de seguridad: nada borrado revive desde caché/localStorage.
    // Solo se conservan datos de actividades vigentes (relación por ID).
    try {
      const deleted = getDeletedActivityIds();
      const valid = new Set(store().activities.map(a => a.id));
      if(pruneOrphanActivityNotifs(valid, deleted)) changed++;
      if(pruneOrphanSubmissions(valid, deleted)) changed++;
      if(pruneOrphanGradeNotifs(valid, deleted)) changed++;
    } catch(e){}
    // Docente: elimina huérfanos legacy en Firestore (entregas, archivos,
    // avisos y notas de actividades ya inexistentes). Acotado y por ID.
    try {
      if(session.rol === 'docente'){
        const deleted = getDeletedActivityIds();
        const valid = new Set(store().activities.map(a => a.id));
        if(await cleanupOrphanedCloudData(valid, deleted)) changed++;
      }
    } catch(e){ console.warn('cleanup huérfanos:', e); }
    markFullSync();
    _cloudStatus = 'conectado';
    if(changed){ render(); if(manual) toast('✅ Sincronizado con la nube'); }
    else { refreshNavBadge(); if(manual) toast('✅ Ya estás al día'); }
  } catch(e){
    console.warn('pullAllCloudData falló:', e);
    _cloudStatus = 'sin-conexion';
    if(manual) toast('⚠️ No se pudo sincronizar. Revisa tu conexión y reglas de Firestore.');
  }
}
/* --- TIEMPO REAL: onSnapshot; lo que el docente publique aparece solo --- */
let _unsubs = [];
function stopRealtime(){ try { _unsubs.forEach(u => { try{u();}catch(e){} }); } catch(e){} _unsubs = []; }
function subscribeRealtime(){
  stopRealtime();
  if(!db || !session) return;
  try {
    // 1) Actividades en vivo
    _unsubs.push(db.collection('activities').onSnapshot(snap => {
      try {
        const d = store();
        const byId = new Map(d.activities.map(a => [a.id, a]));
        let changed = false;
        snap.docChanges().forEach(ch => {
          const data = Object.assign({}, ch.doc.data() || {}, { id: ch.doc.id });
          if(ch.type === 'removed'){ if(byId.delete(ch.doc.id)) changed = true; }
          else {
            const cur = byId.get(ch.doc.id);
            if(!cur || JSON.stringify(cur) !== JSON.stringify(data)){ byId.set(ch.doc.id, data); changed = true; }
          }
        });
        if(changed){
          d.activities = [...byId.values()];
          try { saveStore(d); } catch(e){}
          // Si una actividad se eliminó en otro dispositivo, su aviso no
          // debe quedarse colgado: pódalo del caché local de inmediato.
          try {
            const removedIds = [];
            snap.docChanges().forEach(ch => { if(ch.type === 'removed') removedIds.push(ch.doc.id); });
            if(removedIds.length){
              const del = getDeletedActivityIds();
              removedIds.forEach(id => del.add(id));
              saveDeletedActivityIds(del);
              const before = getActivityNotifs();
              const kept = before.filter(n => {
                const aid = n.activityId || (n.id || '').replace(/^an_/, '');
                return !removedIds.includes(aid) && !removedIds.includes(n.id);
              });
              if(kept.length !== before.length) saveActivityNotifs(kept);
              // Podar también entregas y notas de esas actividades (en vivo,
              // en todos los dispositivos, sin esperar al próximo pull).
              try {
                const d2 = store();
                const ks = d2.submissions.filter(s => !(s.activityId && removedIds.includes(s.activityId)));
                if(ks.length !== d2.submissions.length){ d2.submissions = ks; try { saveStore(d2); } catch(e){} }
              } catch(e){}
              try {
                const gk = getGradeNotifs().filter(n => !(n.activityId && removedIds.includes(n.activityId)));
                if(gk.length !== getGradeNotifs().length) saveGradeNotifs(gk);
              } catch(e){}
            }
            pruneOrphanActivityNotifs(new Set(d.activities.map(a => a.id)), getDeletedActivityIds());
            try { pruneOrphanSubmissions(new Set(d.activities.map(a => a.id)), getDeletedActivityIds()); } catch(e){}
            try { pruneOrphanGradeNotifs(new Set(d.activities.map(a => a.id)), getDeletedActivityIds()); } catch(e){}
          } catch(e){}
          // Si es estudiante y llegó una actividad nueva publicada, avisa.
          try { detectNewActivityAlert(snap); } catch(e){}
          render();
        }
      } catch(e){ console.warn('RT activities:', e); }
    }, err => console.warn('RT activities error:', err)));
    // 2) Entregas en vivo (docente: todas; estudiante: suyas)
    const subQuery = (session.rol === 'estudiante')
      ? db.collection('submissions').where('email', '==', session.email)
      : db.collection('submissions');
    _unsubs.push(subQuery.onSnapshot(snap => {
      try {
        const d = store();
        const byId = new Map(d.submissions.map(s => [s.id, s]));
        let changed = false;
        let delRT = null;
        try { delRT = getDeletedActivityIds(); } catch(e){}
        snap.docChanges().forEach(ch => {
          const data = Object.assign({}, ch.doc.data() || {}, { id: ch.doc.id });
          const aid = data.activityId || '';
          // Doc zombie de actividad borrada: no entra al caché (ni revive).
          if(aid && delRT && delRT.has(aid)){
            if(byId.delete(ch.doc.id)) changed = true;
            return;
          }
          if(ch.type === 'removed'){ if(byId.delete(ch.doc.id)) changed = true; }
          else { const cur = byId.get(ch.doc.id); if(!cur || JSON.stringify(cur) !== JSON.stringify(data)){ byId.set(ch.doc.id, data); changed = true; } }
        });
        if(changed){
          d.submissions = [...byId.values()];
          try{ saveStore(d); }catch(e){}
          try { pruneOrphanSubmissions(validActivityIdSet(), getDeletedActivityIds()); } catch(e){}
          render();
        }
      } catch(e){ console.warn('RT submissions:', e); }
    }, err => console.warn('RT submissions error:', err)));
    // 3) Avisos de nuevas actividades en vivo
    _unsubs.push(db.collection('activity_notifications').onSnapshot(snap => {
      try {
        const local = getActivityNotifs();
        const byIdN = new Map(local.map(n => [n.id, n]));
        let changed = false;
        snap.docChanges().forEach(ch => {
          const data = Object.assign({}, ch.doc.data() || {}, { id: ch.doc.id });
          if(ch.type === 'removed'){ if(byIdN.delete(ch.doc.id)) changed = true; }
          else {
            const cur = byIdN.get(ch.doc.id);
            // La lectura local manda: no revivir como sin leer lo ya leído.
            if(cur && cur.read){ data.read = true; data.readAt = data.readAt || cur.readAt; }
            if(!cur || JSON.stringify(cur) !== JSON.stringify(data)){ byIdN.set(ch.doc.id, data); changed = true; }
          }
        });
        if(changed){
          saveActivityNotifs([...byIdN.values()]);
          render();
          const unread = myUnreadActivityNotifs();
          if(session.rol === 'estudiante' && unread.length) toast('📚 Nueva actividad: ' + (unread[0].activityTitle || 'revisa tus módulos'));
        }
      } catch(e){ console.warn('RT actNotifs:', e); }
    }, err => console.warn('RT actNotifs error:', err)));
    // 4) Calificaciones y claves en vivo
    // Docente: ve/borra notas igual en todo dispositivo (solo vigentes).
    if(session.rol !== 'estudiante'){
      _unsubs.push(db.collection('grade_notifications').onSnapshot(async () => {
        try { const c = await pullGradeNotifsFromCloud().catch(()=>0); if(c) render(); else refreshNavBadge(); } catch(e){}
      }, err => console.warn('RT grades error:', err)));
    }
    if(session.rol === 'estudiante'){
      const mail = session.email;
      _unsubs.push(db.collection('grade_notifications').where('studentEmail', '==', (mail||'').toLowerCase()).onSnapshot(async () => {
        try { const c = await pullGradeNotifsFromCloud().catch(()=>0); if(c) render(); else refreshNavBadge(); } catch(e){}
      }, ()=>{}));
      _unsubs.push(db.collection('password_resets').where('studentEmail', '==', (mail||'').toLowerCase()).onSnapshot(async () => {
        try { const c = await pullPwdResetsFromCloud().catch(()=>0); if(c) render(); else refreshNavBadge(); } catch(e){}
      }, ()=>{}));
    }
  } catch(e){ console.warn('subscribeRealtime falló:', e); }
}

function getCachedUserByEmail(email){
  try {
    const arr = JSON.parse(localStorage.getItem('eduaula_users_extra') || '[]');
    return arr.find(u => u.email.toLowerCase() === (email||'').toLowerCase()) || null;
  } catch(e){ return null; }
}
function demoLogin(r, email){
  hideAuthError();
  const mail = (email || document.getElementById('loginEmail')?.value || '').trim();
  if(!mail){ showAuthError('⚠️ Escribe tu correo.'); return; }
  // Si el correo ya está registrado en caché con otro rol, bloquear (evita cruce estudiante<->docente)
  const cached = getCachedUserByEmail(mail);
  if(cached && cached.rol !== r){
    if(cached.rol === 'docente')
      showAuthError('⛔ Este correo pertenece a un DOCENTE. Selecciona el rol “Docente”.');
    else
      showAuthError('⛔ Este correo pertenece a un ESTUDIANTE. Selecciona el rol “Estudiante”.');
    return;
  }
  const base = mail.split('@')[0].replace(/[._-]+/g,' ').trim() || (r==='docente'?'Docente':'Estudiante');
  const pretty = base.replace(/\b\w/g, c=>c.toUpperCase());
  if(r==='docente'){ enterApp({ nombre: pretty, email: mail.toLowerCase(), rol:'docente', curso:'2 módulos' }); }
  else{
    const found = getAllStudents().find(s=>s.email.toLowerCase()===mail.toLowerCase());
    enterApp({ nombre: found?.nombre || pretty, email: mail.toLowerCase(), rol:'estudiante', grado: found?.grado||'', seccion: found?.seccion||'' });
  }
}
function enterApp(user){
  session = user;
  persistSession(user);
  startIdleWatch();
  // Sincroniza las pestañas de rol con la sesión real
  if(user.rol && user.rol !== currentRole){
    currentRole = user.rol;
    document.getElementById('roleDocente')?.classList.toggle('active', currentRole==='docente');
    document.getElementById('roleEstudiante')?.classList.toggle('active', currentRole==='estudiante');
    updateGradeVisibility();
  }
  hideBoot();
  document.getElementById('loginView').style.display='none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('rolePill').textContent = session.rol.toUpperCase();
  document.getElementById('brandRole').textContent = session.rol==='docente'?'Panel docente':('Panel estudiante · ' + formatGradoSeccion(session));
  document.getElementById('miniName').textContent = session.nombre + (session.rol==='estudiante' && formatGradoSeccion(session) ? ' · ' + formatGradoSeccion(session) : '');
  document.getElementById('miniMail').textContent=session.email;
  document.getElementById('miniAvatar').textContent=session.nombre[0];
  document.getElementById('miniAvatar').style.background = session.rol==='docente'?'#7c3aed':'#0891b2';
  document.getElementById('topCreateBtn').style.display = session.rol==='docente'?'':'none';
  buildNav(); navigate('inicio');
  // Sincronización multi-dispositivo: PULL inicial + tiempo real.
  // localStorage es solo caché; Firestore es la verdad compartida.
  try {
    pullAllCloudData(false);
    subscribeRealtime();
    checkFirebaseConnection().then(r => {
      if(!r.ok && r.reason === 'error-permisos')
        console.warn('Revisa Firestore Rules: permite read/write en activities, submissions, activity_notifications, grade_notifications, password_resets, users.');
    });
  } catch(e){ console.warn('Sync inicial falló:', e); }
}
function logout(){
  stopIdleWatch();
  try { stopRealtime(); } catch(e){}
  clearPersistedSession();
  if(auth){ auth.signOut().finally(()=>location.reload()); }
  else location.reload();
}
/* ---------- Persistencia de sesión (sin parpadeo del login) ----------
   - Al entrar se guarda una copia ligera en localStorage (SESSION_KEY).
   - Al cargar la página se restaura de inmediato si existe (sin mostrar el login).
   - Firebase (persistencia local) confirma en segundo plano: si la sesión
     de Firebase ya no existe o el rol cambió, se respeta y se ajusta.
   - El login SOLO se muestra si no hay sesión válida. Solo se sale con logout manual. */
const SESSION_KEY = 'eduaula_session';
function persistSession(user){
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      nombre: user.nombre, email: user.email, rol: user.rol,
      grado: user.grado || '', seccion: user.seccion || '',
      curso: user.curso || '', uid: user.uid || ''
    }));
  } catch(e){}
}
function getPersistedSession(){
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if(!raw) return null;
    const s = JSON.parse(raw);
    if(!s || typeof s.email !== 'string' || !s.email) return null;
    if(s.rol !== 'docente' && s.rol !== 'estudiante') return null;
    if(typeof s.nombre !== 'string' || !s.nombre) return null;
    return { nombre: s.nombre, email: s.email, rol: s.rol, grado: s.grado || '', seccion: s.seccion || '', curso: s.curso || '', uid: s.uid || '' };
  } catch(e){ return null; }
}
function clearPersistedSession(){ try { localStorage.removeItem(SESSION_KEY); } catch(e){} }
function hideBoot(){
  const b = document.getElementById('bootView');
  if(b) b.style.display = 'none';
  window.__eduaula_booted = true;
}
/* Muestra el login SOLO cuando no hay sesión válida */
function showLogin(){
  session = null;
  stopIdleWatch();
  hideBoot();
  document.getElementById('app').classList.remove('visible');
  document.getElementById('loginView').style.display = '';
  // Avisa si la salida fue por inactividad
  try {
    if(localStorage.getItem('eduaula_idle_logout') === '1'){
      localStorage.removeItem('eduaula_idle_logout');
      const b = document.getElementById('authError');
      if(b){ b.textContent = '🔒 Sesión cerrada por inactividad (más de 5 minutos). Vuelve a ingresar.'; b.style.display = ''; }
    }
  } catch(e){}
}
/* ---------- Cierre automático por inactividad (5 minutos) ----------
   Cualquier clic, tecla, movimiento, toque o scroll reinicia el conteo.
   A los 4 min avisa una vez; a los 5 min cierra la sesión y recarga al login. */
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const IDLE_WARN_MS = 4 * 60 * 1000;
const IDLE_CHECK_MS = 10 * 1000;
let _lastActivity = Date.now();
let _idleWarned = false;
let _idleTimer = null;
function markActivity(){
  _lastActivity = Date.now();
  _idleWarned = false;
}
function startIdleWatch(){
  stopIdleWatch();
  _lastActivity = Date.now();
  _idleWarned = false;
  const evs = ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'];
  try { evs.forEach(ev => window.addEventListener(ev, markActivity, { passive: true })); } catch(e){}
  _idleTimer = setInterval(() => {
    if(!session) return;
    const idle = Date.now() - _lastActivity;
    if(idle >= IDLE_LIMIT_MS){ idleLogout(); return; }
    if(idle >= IDLE_WARN_MS && !_idleWarned){
      _idleWarned = true;
      try { toast('⏳ Por inactividad tu sesión se cerrará en 1 minuto'); } catch(e){}
    }
  }, IDLE_CHECK_MS);
  startIdleWatch._on = true;
}
function stopIdleWatch(){
  if(_idleTimer){ clearInterval(_idleTimer); _idleTimer = null; }
  if(startIdleWatch._on){
    const evs = ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'];
    try { evs.forEach(ev => window.removeEventListener(ev, markActivity)); } catch(e){}
    startIdleWatch._on = false;
  }
}
function idleLogout(){
  stopIdleWatch();
  try { stopRealtime(); } catch(e){}
  clearPersistedSession();
  try { localStorage.setItem('eduaula_idle_logout', '1'); } catch(e){}
  if(auth){ try { auth.signOut().finally(() => location.reload()); } catch(e){ location.reload(); } }
  else location.reload();
}
function notifBadgeHTML(count){
  if(!count) return '';
  return `<span class="nav-badge">${count > 9 ? '9+' : count}</span>`;
}
function buildNav(){
  const n=document.getElementById('sideNav');
  if(session.rol==='docente'){
    const pend = docentePendingCount();
    n.innerHTML=`
      <div class="sec">Principal</div>
      <button data-r="inicio" onclick="navigate('inicio')">🏠 Inicio</button>
      <button data-r="cursos" onclick="navigate('cursos')">📚 Mis módulos</button>
      <button data-r="actividades" onclick="navigate('actividades')">📝 Actividades</button>
      <div class="sec">Seguimiento</div>
      <button data-r="entregas" onclick="navigate('entregas')">📤 Trabajos</button>
      <button data-r="estudiantes" onclick="navigate('estudiantes')">👥 Estudiantes</button>
      <button data-r="notificaciones" onclick="navigate('notificaciones')">🔔 Notificaciones ${notifBadgeHTML(pend)}</button>
      <div class="sec">Cuenta</div>
      <button data-r="config" onclick="navigate('config')">⚙️ Configuración</button>
      <button onclick="navigate('perfil')">👤 Mi perfil</button>`;
  } else {
    let pend = 0;
    try { pend = studentNotifCount(); } catch(e){ pend = myPendingResets().length; }
    n.innerHTML=`
      <div class="sec">Principal</div>
      <button data-r="inicio" onclick="navigate('inicio')">🏠 Inicio</button>
      <button data-r="cursos" onclick="navigate('cursos')">📚 Mis módulos</button>
      <button data-r="actividades" onclick="navigate('actividades')">📝 Actividades</button>
      <div class="sec">Mi trabajo</div>
      <button data-r="misentregas" onclick="navigate('misentregas')">📤 Mis trabajos</button>
      <button data-r="notificaciones" onclick="navigate('notificaciones')">🔔 Notificaciones ${notifBadgeHTML(pend)}</button>
      <button data-r="perfil" onclick="navigate('perfil')">👤 Mi perfil</button>`;
  }
}
function refreshNavBadge(){
  try { buildNav(); } catch(e){}
  try {
    document.querySelectorAll('#sideNav button').forEach(b=>b.classList.toggle('active',
      b.dataset.r===route||(route==='curso'&&b.dataset.r==='cursos')));
  } catch(e){}
}
function navigate(r,p=null){
  // Validación de permisos por módulo (estudiantes): bloquea curso y actividad no habilitados
  if(session && session.rol === 'estudiante'){
    if(r === 'curso' && p && !canAccessModule(p)){ toastLocked(p); r = 'cursos'; p = null; }
    if(r === 'actividad' && p){
      const ax = store().activities.find(x => x.id === p);
      if(ax && !canAccessModule(ax.curso)){ toastLocked(ax.curso); r = 'cursos'; p = null; }
    }
  }
  route=r; routeParam=p; document.getElementById('sidebar').classList.remove('open');
  document.querySelectorAll('#sideNav button').forEach(b=>b.classList.toggle('active',b.dataset.r===r||(r==='curso'&&b.dataset.r==='cursos')));
  render();
}
/* ---------- Sidebar móvil: cerrar al tocar fuera (incluida la zona
   blanca del contenido principal). No cambia el menú actual: el botón ☰
   sigue abriendo/cerrando y navegar también cierra. Solo actúa en móvil
   (<=760px, igual que el CSS) y cuando el sidebar está abierto. */
(function initSidebarOutsideClose(){
  function isMobile(){
    try { return window.matchMedia('(max-width: 760px)').matches; }
    catch(e){ return window.innerWidth <= 760; }
  }
  function closeSidebar(){
    try { document.getElementById('sidebar')?.classList.remove('open'); } catch(e){}
  }
  document.addEventListener('click', function(ev){
    try {
      const sb = document.getElementById('sidebar');
      if(!sb || !sb.classList.contains('open')) return;
      if(!isMobile()) return;
      const t = ev.target;
      // Taps dentro del menú o en el botón ☰ los gestiona el propio menú.
      if(t && t.closest && (t.closest('#sidebar') || t.closest('.hamburger'))) return;
      closeSidebar();
    } catch(e){}
  });
  document.addEventListener('keydown', function(ev){
    if(ev && ev.key === 'Escape'){ try { closeSidebar(); } catch(e){} }
  });
  window.addEventListener('resize', function(){
    try { if(!isMobile()) closeSidebar(); } catch(e){}
  });
})();
let _gsTimer = null;
function onGlobalSearch(v){
  // Antirrebote: evita un navigate+render completo por cada tecla
  clearTimeout(_gsTimer);
  _gsTimer = setTimeout(() => {
    if(route!=='actividades') navigate('actividades');
    setTimeout(()=>{ const i=document.getElementById('actSearch'); if(i){i.value=v; renderActividades(v);} },0);
  }, 250);
}

/* ---------- render dispatcher ---------- */
function render(){
  const v=document.getElementById('view');
  try { refreshNavBadge(); } catch(e){}
  // Sincronización continua: tanto docente (ver entregas de otros
  // dispositivos) como estudiante (ver actividades nuevas) traen la nube.
  // El tiempo real (onSnapshot) ya empuja cambios; esto es respaldo por ruta.
  try {
    if(session && (route==='inicio'||route==='notificaciones'||route==='misentregas'||route==='entregas'||route==='actividades'||route==='cursos'))
      pullAllCloudData(false);
  } catch(e){}
  if(session.rol==='docente'){
    if(route==='inicio') return v.innerHTML=viewDashDocente();
    if(route==='cursos') return v.innerHTML=viewCursos();
    if(route==='curso') return v.innerHTML=viewCursoDetalle(routeParam);
    if(route==='actividades'){ v.innerHTML=viewActividades(''); renderActividades(''); return; }
    if(route==='crear'){ v.innerHTML=viewCrear(null, COURSES[routeParam] ? routeParam : null); updPreview(); return; }
    if(route==='editar'){ v.innerHTML=viewCrear(routeParam); updPreview(); return; }
    if(route==='entregas'){ v.innerHTML=viewEntregas(); renderEntregasRows(routeParam||store().activities.filter(a=>a.estado==='publicada')[0]?.id||store().activities[0]?.id); return; }
    if(route==='entrega-detalle') return v.innerHTML=viewEntregaDetalle(routeParam);
    if(route==='estudiantes'){ v.innerHTML=viewEstudiantes(); renderEstudiantesRows(); return; }
    if(route==='notificaciones') return v.innerHTML=viewNotificaciones();
    if(route==='perfil') return v.innerHTML=viewPerfil();
    if(route==='config') return v.innerHTML=viewConfig();
    if(route==='actividad') return v.innerHTML=viewActividadDocente(routeParam);
  } else {
    if(route==='inicio') return v.innerHTML=viewDashEst();
    if(route==='cursos') return v.innerHTML=viewCursos();
    if(route==='curso') return v.innerHTML=viewCursoDetalle(routeParam);
    if(route==='actividades'){ v.innerHTML=viewActividades(''); renderActividades(''); return; }
    if(route==='actividad'){ v.innerHTML=viewActividadEst(routeParam); return; }
    if(route==='confirmacion') return v.innerHTML=viewConfirmacion(routeParam);
    if(route==='misentregas') return v.innerHTML=viewMisEntregas();
    if(route==='notificaciones') return v.innerHTML=viewNotificaciones();
    if(route==='perfil') return v.innerHTML=viewPerfil();
  }
  v.innerHTML='<div class="card">Ruta no encontrada</div>';
}
function visibleActivities(){
  const {activities}=store();
  if(session.rol==='docente') return activities;
  // Estudiante: solo publicadas Y de módulos habilitados para su grado/sección
  return activities.filter(a=>a.estado==='publicada' && canAccessModule(a.curso));
}

/* ---------- 4. Dashboard docente ---------- */
function viewDashDocente(){
  const {activities,submissions}=store();
  // Solo información vigente: excluye entregas de actividades borradas o
  // inexistentes (relación por ID único) para que lo eliminado no reaparezca.
  let deletedDash = null;
  try { deletedDash = getDeletedActivityIds(); } catch(e){}
  const validDash = new Set(activities.map(a=>a.id));
  const liveSubs = submissions.filter(s => {
    const aid = s.activityId || '';
    if(aid && deletedDash && deletedDash.has(aid)) return false;
    if(aid && !validDash.has(aid)) return false;
    return true;
  });
  const total=activities.length;
  const recibidas=liveSubs.length;
  const pendientes=new Set(activities.filter(a=>a.estado==='publicada').map(a=>a.id)).size*getAllStudents().length - recibidas;
  const publicadas=activities.filter(a=>a.estado==='publicada').length;
  const recientes=[...activities].slice(-4).reverse();
  if(total===0){
    return `
    <h1 class="page-title">¡Hola, ${firstName()}! 👋</h1>
    <p class="page-sub">Gestiona las actividades de tus 2 módulos.</p>
    <div class="stats">
      <div class="stat"><div class="stat-ico" style="background:#ede9fe">📝</div><div><b>0</b><span>Actividades creadas</span></div></div>
      <div class="stat"><div class="stat-ico" style="background:#dcfce7">📥</div><div><b>0</b><span>Trabajos recibidos</span></div></div>
      <div class="stat"><div class="stat-ico" style="background:#dbeafe">👥</div><div><b>${getAllStudents().length}</b><span>Estudiantes registrados</span></div></div>
    </div>
    <div class="card" style="text-align:center;padding:36px">
      <div style="font-size:52px">📝</div>
      <h3>Aún no hay actividades</h3>
      <p class="desc">Crea tu primera actividad <b>dentro de su módulo correspondiente</b> para que tus estudiantes puedan presentar sus trabajos.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-primary" onclick="navigate('crear','moviles')">📱 + Primera actividad en Móviles</button>
        <button class="btn btn-primary" style="background:#f59e0b" onclick="navigate('crear','ensamblaje')">🛠️ + Primera actividad en Ensamblaje</button>
      </div>
    </div>`;
  }
  return `
  <h1 class="page-title">¡Hola, ${displayName()}! 👋</h1>
  <p class="page-sub">Gestiona las actividades de tus 2 módulos. Hoy es ${new Date().toLocaleDateString('es-PE',{weekday:'long',day:'numeric',month:'long'})}.</p>
  <div class="stats">
    <div class="stat"><div class="stat-ico" style="background:#ede9fe">📝</div><div><b>${total}</b><span>Actividades creadas</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#fef9c3">👀</div><div><b>${Math.max(pendientes,0)}</b><span>Pendientes de revisar</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#dcfce7">📥</div><div><b>${recibidas}</b><span>Trabajos recibidos</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#ffedd5">🟢</div><div><b>${publicadas}</b><span>Publicadas</span></div></div>
  </div>
  <div class="grid2">
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap"><h3 style="flex:1;min-width:0">Actividades recientes</h3><button class="btn btn-primary btn-sm" onclick="navigate('crear')">+ Crear actividad</button></div>
      ${recientes.map(a=>{
        const n=store().submissions.filter(s=>s.activityId===a.id).length;
        const st=a.estado==='borrador'?{key:'borrador',label:'Borrador'}:{key:'publicada',label:'Publicada'};
        return `<div class="activity-item" onclick="navigate('actividad','${a.id}')" style="cursor:pointer">
          <div class="act-ico" style="background:#ede9fe">${courseOf(a.curso).icono}</div>
          <div class="act-info"><b>${escHtml(a.titulo)}</b><small>${courseOf(a.curso).nombre} · ⏰ ${fmtFecha(a.limite)} ${fmtHora12(a.hora)} · 📥 ${n} trabajos</small></div>${badge(st)}</div>`;
      }).join('')}
      <button class="btn btn-ghost btn-sm" onclick="navigate('actividades')">Ver todas las actividades →</button>
    </div>
    <div class="card">
      <h3>📤 Últimos trabajos</h3><p class="desc">Trabajos recibidos recientemente.</p>
      ${liveSubs.slice(-4).reverse().map(s=>`<div class="file-chip">📄 <b>${escHtml(s.estudiante)}</b> · ${escHtml(s.archivo)} ${gradeOf(s)!=null?`· ⭐ ${gradeOf(s)}/20`:''}<br><small style="color:#64748b">${fmtFechaHora(s.fecha)} ${s.late?'· ⚠️ tardía':''}</small><button class="btn btn-outline btn-sm" onclick="downloadSubmission('${s.id}')">Descargar</button></div>`).join('')||'<div class="empty">Sin trabajos todavía. Aparecerán aquí cuando los estudiantes presenten.</div>'}
      <div style="margin-top:12px"><button class="btn btn-outline btn-sm" onclick="navigate('entregas')">Abrir trabajos de estudiantes →</button></div>
    </div>
  </div>`;
}

/* ---------- 5. Dashboard estudiante ---------- */
function viewDashEst(){
  const acts=visibleActivities();
  if(acts.length===0){
    return `
    ${studentAlertBanners()}
    <h1 class="page-title">¡Hola, ${firstName()}! 👋</h1>
    <p class="page-sub">Tus 2 módulos.${session.rol==='estudiante'&&formatGradoSeccion(session)?' · '+formatGradoSeccion(session):''}</p>
    <div class="card" style="text-align:center;padding:36px">
      <div style="font-size:52px">📚</div>
      <h3>Sin actividades por ahora</h3>
      <p class="desc">Tu docente aún no publica actividades — o aún no se sincronizan en este dispositivo. Pulsa Actualizar para traerlas de la nube.</p>
      <button class="btn btn-primary btn-sm" onclick="pullAllCloudData(true)">🔄 Buscar actividades en la nube</button>
    </div>`;
  }
  let pend=0,pres=0,venc=0;
  acts.forEach(a=>{ const s=statusForStudent(a,mySubmission(a.id)); if(s.key==='presentado')pres++; else if(s.key==='vencido'||s.key==='tarde')venc++; else pend++; });
  const actsById = {};
  store().activities.forEach(a => { actsById[a.id] = a; });
  const mySubs = store().submissions.filter(s=>s.email===session.email && actsById[s.activityId] && canAccessModule(actsById[s.activityId].curso));
  const prom = avgProm(mySubs);
  const upcoming=acts.map(a=>({a,sub:mySubmission(a.id)})).filter(x=>!x.sub && deadlineOf(x.a)-new Date()>0).sort((x,y)=>deadlineOf(x.a)-deadlineOf(y.a)).slice(0,4);
  const graded = acts.map(a=>({a,sub:mySubmission(a.id)})).filter(x=>x.sub && gradeOf(x.sub)!=null).slice(-4).reverse();
  return `
  ${studentAlertBanners()}
  <h1 class="page-title">¡Hola, ${firstName()}! 👋</h1>
  <p class="page-sub">Este es tu resumen de tareas de tus 2 módulos.${session.rol==='estudiante'&&formatGradoSeccion(session)?' · '+formatGradoSeccion(session):''}</p>
  <div class="stats">
    <div class="stat"><div class="stat-ico" style="background:#dbeafe">🔵</div><div><b>${pend}</b><span>Pendientes</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#dcfce7">🟢</div><div><b>${pres}</b><span>Presentados</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#fee2e2">🔴</div><div><b>${venc}</b><span>Vencidos</span></div></div>
    <div class="stat"><div class="stat-ico" style="background:#fef9c3">⭐</div><div><b>${prom}</b><span>Promedio</span></div></div>
  </div>
  <div class="card">
    <h3>⭐ Mis calificaciones</h3><p class="desc">Notas que tu docente ya registró (escala 0–20).</p>
    ${graded.map(({a,sub})=>`<div class="activity-item" onclick="navigate('actividad','${a.id}')" style="cursor:pointer"><div class="act-ico" style="background:#fef9c3">⭐</div><div class="act-info"><b>${escHtml(a.titulo)}</b><small>${sub.feedback?('💬 '+escHtml(sub.feedback)+' · '):''}${fmtFechaHora(sub.gradedAt||sub.fecha)}</small></div>${gradeBadge(sub)}</div>`).join('')||'<div class="empty">Aún no tienes calificaciones. Aparecerán aquí cuando tu docente califique.</div>'}
  </div>
  <div class="card">
    <h3>⏳ Pendientes por presentar</h3><p class="desc">🟢 Presentado · 🔴 Vencido · 🔵 Pendiente</p>
    ${upcoming.map(({a,sub})=>{const st=statusForStudent(a,sub);return `
      <div class="activity-item" onclick="navigate('actividad','${a.id}')" style="cursor:pointer">
        <div class="act-ico" style="background:#ede9fe">${courseOf(a.curso).icono}</div>
        <div class="act-info"><b>${escHtml(a.titulo)}</b><small>${courseOf(a.curso).nombre} · ⏰ ${fmtFecha(a.limite)} · ${fmtHora12(a.hora)}</small></div>${badge(st)}</div>`;}).join('')||'<div class="empty">🎉 Sin pendientes. ¡Todo al día!</div>'}
  </div>`;
}

/* ---------- 6. Mis módulos + detalle ---------- */
function viewCursos(){
  const counts = {};
  Object.keys(COURSES).forEach(cid => { counts[cid] = store().activities.filter(a=>a.curso===cid&&(session.rol==='docente'||a.estado==='publicada')).length; });
  const isEst = session.rol === 'estudiante';
  const lockedIds = isEst ? Object.keys(COURSES).filter(cid => !canAccessModule(cid)) : [];
  return `
  <h1 class="page-title">📚 Mis módulos</h1>
  <p class="page-sub">${session.rol==='docente'?'Gestionas 2 módulos de secundaria.':('Tus módulos · ' + (formatGradoSeccion(session) || 'Sin grado/sección'))}</p>
  ${lockedIds.length?`<div class="alert alert-red">🔒 Módulo bloqueado para ${formatGradoSeccion(session)}: ${lockedIds.map(id=>courseOf(id).nombre).join(' · ')}. Tu acceso: ${allowedModulesFor(session).map(id=>courseOf(id).corto).join(' · ')}.</div>`:''}
  <div class="grid-courses">
    ${Object.values(COURSES).map(c=>{
      const locked = isEst && !canAccessModule(c.id);
      if(locked) return `
      <div class="course-card locked" onclick="toastLocked('${c.id}')" style="cursor:not-allowed;filter:grayscale(.7);opacity:.75"><div class="course-ico">🔒</div><h3>${c.nombre}</h3><p>${c.desc}</p><span style="margin-top:10px;font-weight:800">🔒 Bloqueado para ${formatGradoSeccion(session)}</span></div>`;
      return `
      <button class="course-card ${c.id}" onclick="navigate('curso','${c.id}')"><div class="course-ico">${c.icono}</div><h3>${c.nombre}</h3><p>${c.desc} · ${counts[c.id]} actividades</p><span style="margin-top:10px;font-weight:800">Ingresar →</span></button>`;
    }).join('')}
  </div>`;
}
function viewBloqueado(cid){
  const c = courseOf(cid);
  return `<button class="btn btn-outline btn-sm" onclick="navigate('cursos')">← Mis módulos</button>
  <div class="card" style="margin-top:12px;text-align:center;padding:36px">
    <div style="font-size:52px">🔒</div>
    <h3>Módulo bloqueado</h3>
    <p class="desc">${lockedMessage(cid)}</p>
    <button class="btn btn-primary" onclick="navigate('cursos')">Ver mis módulos</button>
  </div>`;
}
function viewCursoDetalle(cid){
  if(session.rol === 'estudiante' && !canAccessModule(cid)) return viewBloqueado(cid);
  const c=courseOf(cid); const acts=visibleActivities().filter(a=>a.curso===cid);
  const pendA=acts.filter(a=>{const s=statusForStudent(a,session.rol==='estudiante'?mySubmission(a.id):null);return s.key==='pendiente';});
  const vencA=acts.filter(a=>{const s=statusForStudent(a,session.rol==='estudiante'?mySubmission(a.id):null);return s.key==='vencido'||s.key==='tarde';});
  const presA=acts.filter(a=>session.rol==='estudiante'?mySubmission(a.id):store().submissions.some(s=>s.activityId===a.id));
  return `
  <button class="btn btn-outline btn-sm" onclick="navigate('cursos')">← Mis módulos</button>
  <div class="card" style="margin-top:12px;background:linear-gradient(135deg,#312e81,${c.color||'#4f46e5'});color:#fff;border:0">
    <div style="font-size:40px">${c.icono}</div><h2 style="margin:6px 0">${c.nombre}</h2><p style="opacity:.9;margin:0">${c.desc}</p>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <span class="badge b-gray">📝 ${acts.length} actividades</span>
      <span class="badge b-yellow"><span class="dot"></span>⏳ ${pendA.length} pendientes</span>
      <span class="badge b-green"><span class="dot"></span>✅ ${presA.length} presentados</span>
      <span class="badge b-red"><span class="dot"></span>🔴 ${vencA.length} vencidos</span>
    </div>
  </div>
  ${session.rol==='docente'?`<button class="btn btn-primary" onclick="navigate('crear','${cid}')">+ Crear actividad en este módulo</button>`:''}
  <div class="card" style="margin-top:12px"><h3>Lista de actividades</h3>
  ${acts.map(a=>{
    const sub=session.rol==='estudiante'?mySubmission(a.id):null;
    const st=session.rol==='estudiante'?statusForStudent(a,sub):(a.estado==='borrador'?{key:'borrador',label:'Borrador'}:{key:'publicada',label:'Publicada'});
    const n=store().submissions.filter(s=>s.activityId===a.id).length;
    return `<div class="activity-item" onclick="navigate('actividad','${a.id}')" style="cursor:pointer">
      <div class="act-ico" style="background:#f1f5f9">📄</div>
      <div class="act-info"><b>${escHtml(a.titulo)}</b><small>📅 Pub: ${fmtFecha(a.publicacion)} · ⏰ Límite: ${fmtFecha(a.limite)} ${fmtHora12(a.hora)} ${session.rol==='docente'?'· 📥 '+n+' entregas':''}</small></div>${badge(st)}</div>`;
  }).join('')||(session.rol==='docente'
    ? `<div class="empty">No hay actividades en este módulo.<br><br><button class="btn btn-primary btn-sm" onclick="navigate('crear','${cid}')">+ Crear primera actividad en ${courseOf(cid).corto}</button></div>`
    : '<div class="empty">No hay actividades en este módulo.</div>')}</div>`;
}

/* ---------- 7. Lista actividades ---------- */
function viewActividades(q){
  return `<h1 class="page-title">📝 Actividades</h1>
  <p class="page-sub">${session.rol==='docente'?'Crea, edita y elimina actividades. Se guardan en la nube y llegan solas a todos los dispositivos.':'Consulta y entrega tus trabajos. Se sincronizan en tiempo real desde la nube.'}</p>
  <div class="alert ${_cloudStatus==='conectado'?'alert-green':'alert-yellow'}" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px">${_cloudStatus==='conectado'?'☁️ Sincronizado con Firestore: lo que ves aquí es lo compartido.':'⚠️ Estado nube: '+_cloudStatus+'. Pulsa Actualizar.'}</span><button class="btn btn-outline btn-sm" onclick="pullAllCloudData(true)">🔄 Actualizar</button></div>
  ${session.rol==='estudiante' && Object.keys(COURSES).some(cid=>!canAccessModule(cid))?`<div class="alert alert-red">🔒 Bloqueado para ${formatGradoSeccion(session)}: ${Object.keys(COURSES).filter(cid=>!canAccessModule(cid)).map(id=>courseOf(id).nombre).join(' · ')}</div>`:''}
  <div class="card">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <input id="actSearch" placeholder="🔍 Buscar por título…" value="${q||''}" oninput="renderActividades(this.value)" style="flex:1;min-width:200px;border:1px solid var(--border);border-radius:10px;padding:10px 12px">
      <select id="actCourse" onchange="renderActividades(document.getElementById('actSearch').value)" style="border:1px solid var(--border);border-radius:10px;padding:10px"><option value="">Todos</option>${Object.values(COURSES).map(c=>`<option value="${c.id}">${c.icono} ${c.corto}</option>`).join('')}</select>
      ${session.rol==='docente'?`<button class="btn btn-primary btn-sm" onclick="navigate('crear')">+ Crear actividad</button>`:''}
    </div>
    <div id="actList" style="margin-top:12px"></div>
  </div>`;
}
function renderActividades(q){
  const box=document.getElementById('actList'); if(!box) return;
  const cf=document.getElementById('actCourse')?.value||'';
  const list=visibleActivities().filter(a=>(!cf||a.curso===cf)&&a.titulo.toLowerCase().includes((q||'').toLowerCase()));
  box.innerHTML=list.map(a=>{
    const sub=session.rol==='estudiante'?mySubmission(a.id):null;
    const st=session.rol==='estudiante'?statusForStudent(a,sub):(a.estado==='borrador'?{key:'borrador',label:'Borrador'}:{key:'publicada',label:'Publicada'});
    return `<div class="activity-item"><div class="act-ico" style="background:#ede9fe">${courseOf(a.curso).icono}</div>
    <div class="act-info"><b>${escHtml(a.titulo)}</b><small>${courseOf(a.curso).nombre} · ⏰ ${fmtFecha(a.limite)} ${fmtHora12(a.hora)}</small></div>${badge(st)}
    <button class="btn btn-ghost btn-sm" onclick="navigate('actividad','${a.id}')">Ver</button>
    ${session.rol==='docente'?`<button class="btn btn-outline btn-sm" onclick="navigate('editar','${a.id}')">✏️</button><button class="btn btn-danger btn-sm" onclick="delActivity('${a.id}')">🗑</button>`:''}</div>`;
  }).join('')||'<div class="empty">Sin actividades todavía.<br><small>Crea la primera con “+ Crear actividad” y elígela en su módulo correspondiente.</small></div>';
}

/* ---------- 8. Crear / Editar (siempre en su módulo correspondiente) ---------- */
function viewCrear(editId, presetCurso){
  let a;
  if(editId){
    a = store().activities.find(x=>x.id===editId);
    if(!a) return '<div class="card">Actividad no encontrada</div>';
    // Legacy "comp": obligar a reasignar a un módulo correspondiente
    if(!COURSES[a.curso]) a = {...a, curso: (presetCurso && COURSES[presetCurso]) ? presetCurso : 'moviles'};
  } else {
    const initialCurso = (presetCurso && COURSES[presetCurso]) ? presetCurso : 'moviles';
    a = {curso:initialCurso,titulo:'',descripcion:'',instrucciones:'',material:'',publicacion:new Date().toISOString().slice(0,10),limite:'2026-10-15',hora:'23:59',tipos:'.pdf,.docx,.pptx',multiple:true,estado:'publicada',permitirTarde:false};
  }
  pendingFiles=[]; pendingFileHandles=[];
  const destCurso = courseOf(a.curso);
  const isLegacy = editId && !COURSES[store().activities.find(x=>x.id===editId)?.curso];
  const backTarget = COURSES[a.curso] ? `navigate('curso','${a.curso}')` : `navigate('actividades')`;
  const backLabel = COURSES[a.curso] ? `← Volver a ${destCurso.corto}` : '← Volver';
  return `
  <button class="btn btn-outline btn-sm" onclick="${backTarget}">${backLabel}</button>
  <h1 class="page-title" style="margin-top:10px">${editId?'✏️ Editar actividad':'➕ Crear nueva actividad'}</h1>
  <p class="page-sub">Completa los datos y previsualiza cómo la verá el estudiante.</p>
  <div class="alert alert-blue">📚 Esta actividad se creará / guardará en el módulo correspondiente: <b>${destCurso.icono} ${destCurso.nombre}</b>${isLegacy?' · <b>⚠️ Era del curso anterior: elige su módulo definitivo.</b>':''}</div>
  <div class="grid2">
  <div class="card">
    <div class="form-grid">
      <div class="field"><label>Módulo</label><select id="f_curso" oninput="updPreview()">${courseOptions(a.curso)}</select></div>
      <div class="field"><label>Estado</label><select id="f_estado" oninput="updPreview()"><option value="publicada" ${a.estado==='publicada'?'selected':''}>🟢 Publicada</option><option value="borrador" ${a.estado==='borrador'?'selected':''}>📝 Borrador</option></select></div>
      <div class="field full"><label>Título de la actividad</label><input id="f_titulo" value="${escHtml(a.titulo)}" placeholder="Ej. PowerPoint: Mi proyecto de vida" oninput="updPreview()"></div>
      <div class="field full"><label>Descripción</label><textarea id="f_desc" oninput="updPreview()">${escHtml(a.descripcion)}</textarea></div>
      <div class="field full"><label>Instrucciones para el estudiante</label><textarea id="f_inst" oninput="updPreview()">${escHtml(a.instrucciones)}</textarea></div>
      <div class="field"><label>📎 Material de apoyo (se guarda en Supabase, máx. 10 MB)</label><input type="file" id="f_mat" onchange="updPreview()"><small>${a.material?'Actual: '+escHtml(a.material):''}</small></div>
      <div class="field"><label>Tipos permitidos al estudiante</label><input id="f_tipos" value="${escHtml(a.tipos)}" oninput="updPreview()"></div>
      <div class="field"><label>Fecha de publicación</label><input type="date" id="f_pub" value="${a.publicacion}"></div>
      <div class="field"><label>Fecha límite</label><input type="date" id="f_lim" value="${a.limite}" oninput="updPreview()"></div>
      <div class="field"><label>Hora límite</label><input type="time" id="f_hora" value="${a.hora}" oninput="updPreview()"></div>
      <div class="field"><label>Opciones</label><div style="font-size:13.5px"><label><input type="checkbox" id="f_mult" ${a.multiple?'checked':''}> Permitir varios archivos</label><br><label><input type="checkbox" id="f_tarde" ${a.permitirTarde?'checked':''}> Aceptar entregas tardías</label></div></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-outline" onclick="saveActivity('${editId||''}','borrador')">💾 Guardar borrador</button>
      <button class="btn btn-primary" onclick="saveActivity('${editId||''}','publicada')">🚀 ${editId?'Guardar cambios':'Publicar actividad'}</button>
    </div>
  </div>
  <div><div class="card"><h3>👁 Vista previa — así la verá el estudiante</h3><div id="previewBox" class="preview"></div></div></div>
  </div>`;
}
function updPreview(){
  const g=id=>document.getElementById(id)?.value||'';
  const box=document.getElementById('previewBox'); if(!box) return;
  box.innerHTML=`<b>${escHtml(g('f_titulo'))||'Título de la actividad'}</b><br><small>Módulo: ${courseOf(g('f_curso')).nombre}</small><p style="font-size:13px">${escHtml((g('f_desc')||'Descripción…').slice(0,160))}</p><div class="alert alert-blue" style="margin:0">⏰ Límite: ${escHtml(g('f_lim'))} · ${escHtml(g('f_hora'))} · Tipos: ${escHtml(g('f_tipos'))}</div>`;
}
async function saveActivity(editId,estado){
  const g=id=>document.getElementById(id).value;
  const titulo=g('f_titulo').trim();
  if(!titulo){toast('⚠️ Escribe un título');return;}
  if(!g('f_lim')){toast('⚠️ Define la fecha límite');return;}
  let cursoSel=g('f_curso')||'moviles';
  // Las actividades SOLO viven en un módulo correspondiente (moviles/ensamblaje).
  // Si viene legacy u otro valor, se reasigna a un módulo válido.
  if(!COURSES[cursoSel]){
    if(editId){
      const prev=store().activities.find(x=>x.id===editId);
      cursoSel=(prev && COURSES[prev.curso]) ? prev.curso : 'moviles';
    } else {
      cursoSel = (routeParam && COURSES[routeParam]) ? routeParam : 'moviles';
    }
    toast('⚠️ Módulo no válido: se asignó a "'+courseOf(cursoSel).corto+'".');
  }
  const d=store();
  const obj={curso:cursoSel,titulo,descripcion:g('f_desc'),instrucciones:g('f_inst'),tipos:g('f_tipos')||'.pdf',publicacion:g('f_pub')||new Date().toISOString().slice(0,10),limite:g('f_lim'),hora:g('f_hora')||'23:59',multiple:document.getElementById('f_mult').checked,permitirTarde:document.getElementById('f_tarde').checked,estado,creadoPor:session?.email||'',creadoEn:new Date().toISOString()};
  const f=document.getElementById('f_mat').files[0];
  const finalId = editId || ('a'+Date.now());
  obj.id = finalId;
  if(f){
    if(f.size > MAX_FILE_BYTES){ toast('⚠️ El material supera 10 MB'); return; }
    obj.material=f.name;
    obj.materialMime = f.type || mimeForExt(f.name);
    // 1) Supabase Storage (original hasta 10MB)
    if(supa){
      try{ toast('☁️ Subiendo material a Supabase…'); const up = await uploadFileToSupabase(SUPA_BUCKET, `${SUPA_MAT_PREFIX}/${finalId}/${Date.now()}_${sanitizePath(f.name)}`, f); obj.materialUrl = up.url; obj.materialPath = up.path; }catch(err){ console.warn('Material a Supabase falló:', err); toast('⚠️ No se pudo subir a Supabase. Revisa tu configuración.'); }
    } else { toast('⚠️ Supabase no configurado: pega tu URL y anon key en app.js'); }
    // 2) Respaldo local solo si es liviano y no hay URL
    try{ if(!obj.materialUrl && f.size <= INLINE_MAX_BYTES){ obj.materialData = await readFileAsDataUrl(f); } }catch(e){}
  }
  if(editId){
    const i=d.activities.findIndex(a=>a.id===editId);
    if(i<0){toast('⚠️ Actividad no encontrada');return;}
    obj.material=obj.material||d.activities[i].material;
    obj.materialData=obj.materialData||d.activities[i].materialData||'';
    obj.materialMime=obj.materialMime||d.activities[i].materialMime||'';
    obj.materialUrl=obj.materialUrl||d.activities[i].materialUrl||'';
    obj.materialPath=obj.materialPath||d.activities[i].materialPath||'';
    obj.creadoPor=d.activities[i].creadoPor||obj.creadoPor; d.activities[i]={...d.activities[i],...obj};
  }
  else { obj.material=obj.material||''; obj.materialData=obj.materialData||''; obj.materialMime=obj.materialMime||''; obj.materialUrl=obj.materialUrl||''; obj.materialPath=obj.materialPath||''; d.activities.push(obj); }
  // 1) NUBE PRIMERO (fuente compartida): sin esto el estudiante en otro
  // dispositivo jamás ve la actividad. Se espera la escritura y se avisa si falla.
  obj.actualizadoEn = new Date().toISOString();
  // Si el docente republica un id que tenía lápida, la intención manda:
  // se retira la lápida local y en la nube para que no se pode de nuevo.
  try {
    const del = getDeletedActivityIds();
    if(del.has(obj.id)){ del.delete(obj.id); saveDeletedActivityIds(del); }
    if(db) cloudDelete('deleted_activities', obj.id);
  } catch(e){}
  let cloudOk = false;
  if(db){
    try {
      toast('☁️ Guardando en la nube…');
      cloudOk = await cloudSave('activities', obj.id, stripHeavy(obj));
      if(!cloudOk) toast('⚠️ Se guardó local pero la nube falló. Revisa tu conexión y reglas de Firestore.');
    } catch(e){ console.warn('Guardado nube falló:', e); toast('⚠️ No se pudo guardar en la nube.'); }
  } else {
    toast('⚠️ Sin conexión a Firebase: solo se guardó en este dispositivo.');
  }
  try{ saveStore(d); }catch(e){ try{ const lite={...obj,materialData:''}; const d2=store(); const ix=d2.activities.findIndex(a=>a.id===obj.id); if(ix>=0) d2.activities[ix]={...d2.activities[ix],...lite}; else d2.activities.push(lite); saveStore(d2); }catch(_){ toast('⚠️ No se pudo guardar (almacenamiento lleno)'); return; } }
  // 2) NOTIFICACIÓN a estudiantes al publicar (broadcast, llega a todo dispositivo).
  if(estado === 'publicada'){
    try { await pushActivityBroadcast(obj); } catch(e){ console.warn('Broadcast actividad falló:', e); }
  } else {
    // Si vuelve a borrador, retira el aviso para no notificar algo no visible.
    try { await cloudDelete('activity_notifications', 'an_' + obj.id); } catch(e){}
    try {
      const arr = getActivityNotifs().filter(n => n.id !== 'an_' + obj.id);
      saveActivityNotifs(arr);
    } catch(e){}
  }
  toast(estado==='borrador'?'💾 Borrador guardado en '+courseOf(obj.curso).corto:(cloudOk||!db?'🚀 Actividad publicada en '+courseOf(obj.curso).corto+' y notificada a estudiantes':'⚠️ Guardado local; la nube falló — reintenta')); navigate('curso', obj.curso);
}
async function delActivity(id){
  if(!confirm('¿Eliminar esta actividad y sus trabajos?')) return;
  const d = store();
  const act = d.activities.find(a=>a.id===id);
  const subs = d.submissions.filter(s=>s.activityId===id);
  const subIds = new Set(subs.map(s => s.id));
  // 1) Limpieza local INMEDIATA (actividades, entregas y avisos).
  d.activities = d.activities.filter(a=>a.id!==id);
  d.submissions = d.submissions.filter(s=>s.activityId!==id);
  try { saveStore(d); } catch(e){}
  try {
    saveActivityNotifs(getActivityNotifs().filter(n => {
      const aid = n.activityId || (n.id || '').replace(/^an_/, '');
      return aid !== id && n.id !== 'an_' + id;
    }));
  } catch(e){}
  try {
    const garr = getGradeNotifs().filter(n => n.activityId !== id && !subIds.has(n.submissionId));
    saveGradeNotifs(garr);
  } catch(e){}
  try {
    const del = getDeletedActivityIds(); del.add(id); saveDeletedActivityIds(del);
  } catch(e){}
  toast('🗑 Eliminando de la nube…');
  // 2) Nube: lápida PRIMERO (para que ningún dispositivo la resucite),
  // luego borrado esperado de actividad + aviso + entregas + notas.
  try {
    if(db){
      try { await cloudSave('deleted_activities', id, sanitizeForFirestore({ activityId: id, deletedAt: new Date().toISOString(), deletedBy: (session && session.email) || '' })); } catch(e){}
      await Promise.allSettled([
        cloudDelete('activities', id),
        cloudDelete('activity_notifications', 'an_' + id),
        ...subs.map(s => cloudDelete('submissions', s.id))
      ]);
      // Notas asociadas a esa actividad (para que no reaparezcan).
      try {
        const gsnap = await db.collection('grade_notifications').where('activityId', '==', id).get().catch(() => null);
        if(gsnap && !gsnap.empty){
          await Promise.allSettled(gsnap.docs.map(x => cloudDelete('grade_notifications', x.id)));
        }
      } catch(e){ console.warn('Limpieza grade_notifs:', e); }
    }
  } catch(e){ console.warn('delActivity nube:', e); }
  // Borra archivos de Supabase (mejor esfuerzo, no bloquea)
  try{
    if(act?.materialPath) supaRemove(SUPA_BUCKET, [act.materialPath]);
    const wpaths = subs.map(s=>s.storagePath).filter(Boolean);
    if(wpaths.length) supaRemove(SUPA_BUCKET, wpaths);
  }catch(e){}
  toast('🗑 Actividad y sus notificaciones eliminadas');
  if(act && COURSES[act.curso]) navigate('curso', act.curso); else navigate('actividades');
}

/* ---------- Vista actividad (docente resume / estudiante entrega) ---------- */
function viewActividadDocente(id){
  const a=store().activities.find(x=>x.id===id); if(!a) return '<div class="card">No existe</div>';
  const subs=store().submissions.filter(s=>s.activityId===id);
  return `<button class="btn btn-outline btn-sm" onclick="navigate('actividades')">← Actividades</button>
  <div class="card" style="margin-top:12px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="margin:0;flex:1">${escHtml(a.titulo)}</h2>${badge(a.estado==='borrador'?{key:'borrador',label:'Borrador'}:{key:'publicada',label:'Publicada'})}</div>
  <p style="color:#64748b">${courseOf(a.curso).icono} ${courseOf(a.curso).nombre}</p><p>${escHtml(a.descripcion)}</p>
  <dl class="kv"><dt>📅 Publicación</dt><dd>${fmtFecha(a.publicacion)}</dd><dt>⏰ Límite</dt><dd>${fmtFecha(a.limite)} · ${fmtHora12(a.hora)}</dd><dt>📎 Material</dt><dd>${a.material?`<a href="#" onclick="downloadMaterial('${a.id}');return false">📥 ${escHtml(a.material)}</a>`:'—'}</dd><dt>📥 Trabajos</dt><dd>${subs.length} / ${getAllStudents().length}</dd></dl>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="navigate('editar','${a.id}')">✏️ Editar</button><button class="btn btn-ghost btn-sm" onclick="navigate('entregas')">📤 Ver trabajos</button><button class="btn btn-danger btn-sm" onclick="delActivity('${a.id}')">Eliminar</button></div></div>`;
}

/* 8-12. Vista estudiante + subir + confirmación */
function viewActividadEst(id){
  const a=store().activities.find(x=>x.id===id); if(!a) return '<div class="card">No existe</div>';
  if(!canAccessModule(a.curso)) return viewBloqueado(a.curso);
  const sub=mySubmission(id);
  const st=statusForStudent(a,sub);
  const diff=deadlineOf(a)-new Date();
  const dias=Math.ceil(diff/(24*3600*1000));
  const vencida=diff<0 && !a.permitirTarde;
  let countHtml = sub ? `<div class="alert alert-green">✓ Presentado ${sub.late?'fuera de plazo':'a tiempo'} · ${fmtFechaHora(sub.fecha)}</div>`
    : vencida ? `<div class="alert alert-red">⚠️ Actividad vencida — ya no se aceptan trabajos.</div>`
    : `<div class="countdown">📅 <b>Faltan ${dias} día(s) para presentar</b><br><small>Límite: ${fmtFecha(a.limite)} · ${fmtHora12(a.hora)}</small></div>`;
  return `
  <button class="btn btn-outline btn-sm" onclick="navigate('curso','${a.curso}')">← ${courseOf(a.curso).nombre}</button>
  <div class="card" style="margin-top:12px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="margin:0;flex:1">${escHtml(a.titulo)}</h2>${badge(st)}</div>
    <p style="color:#64748b"><b>Módulo:</b> ${courseOf(a.curso).nombre}</p>
    <h3>Descripción</h3><p>${escHtml(a.descripcion)||'—'}</p>
    <h3>Instrucciones</h3><p style="white-space:pre-line;background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:12px">${escHtml(a.instrucciones)||'—'}</p>
<dl class="kv"><dt>📎 Material de apoyo</dt><dd>${a.material?`<a href="#" onclick="downloadMaterial('${a.id}');return false">📥 ${escHtml(a.material)}</a>`:'Sin material adjunto'}</dd>
    <dt>📅 Fecha de publicación</dt><dd>${fmtFecha(a.publicacion)}</dd>
    <dt>⏰ Fecha límite</dt><dd><b>${fmtFecha(a.limite)}</b></dd><dt>🕐 Hora límite</dt><dd><b>${fmtHora12(a.hora)}</b></dd>${sub&&gradeOf(sub)!=null?`<dt>⭐ Mi nota</dt><dd>${gradeBadge(sub)}${sub.feedback?`<br><small>💬 ${escHtml(sub.feedback)}</small>`:''}${sub.gradedAt?`<br><small style="color:#64748b">Calificado: ${fmtFechaHora(sub.gradedAt)}</small>`:''}</dd>`:''}</dl>
    ${countHtml}
  </div>
  <div class="card">
    <h3>📤 Sube tu trabajo</h3>
    ${sub?`<div class="alert alert-green">✓ Trabajo presentado correctamente<br><small>📅 ${fmtFechaHora(sub.fecha)} · 📄 ${escHtml(sub.archivo)} (${escHtml(sub.tam)}) · Estado: ${sub.late?'Fuera de plazo':'Presentado'}</small></div>
      ${gradeOf(sub)!=null?`<div class="alert alert-blue">⭐ Tu nota: <b>${gradeOf(sub)}/20</b>${sub.feedback?` — 💬 ${escHtml(sub.feedback)}`:''}</div>`:`<div class="alert alert-blue">⏳ Tu trabajo está en revisión. Tu nota aparecerá aquí cuando el docente califique.</div>`}
      ${!vencida?`<p style="font-size:13.5px;color:#64748b">Puedes reemplazar tu archivo antes de la fecha límite.</p>`:''}`
    :''}
    ${(!sub||!vencida)?`
    <div class="dropzone" id="dz" onclick="document.getElementById('fileIn').click()" ondragover="event.preventDefault();this.classList.add('over')" ondragleave="this.classList.remove('over')" ondrop="dropFiles(event)">
      📁 Arrastra y suelta tus archivos aquí<br><small>o haz clic para seleccionar · Permitidos: ${a.tipos} · Máx. 10 MB por archivo</small>
      <input type="file" id="fileIn" ${a.multiple?'multiple':''} style="display:none" onchange="pickFiles(this)">
    </div>
    <div id="fileList"></div>
    <button class="btn btn-success" style="margin-top:12px;${vencida&&!sub?'opacity:.5;pointer-events:none':''}" onclick="submitWork('${a.id}')">${sub?'🔄 Reemplazar y enviar de nuevo':'📨 Enviar trabajo'}</button>
    ${vencida&&!sub?'<p style="color:#dc2626;font-size:13px">⚠️ Actividad vencida. No se permite el envío salvo autorización del docente.</p>':''}
    `:''}
  </div>`;
}
async function pickFiles(inp){
  const files = [...inp.files];
  pendingFiles = []; pendingFileHandles = [];
  for(const f of files){
    if(f.size > MAX_FILE_BYTES){ toast('⚠️ "'+f.name+'" supera 10 MB y no se puede subir'); continue; }
    let dataUrl = '';
    try { if(f.size <= INLINE_MAX_BYTES) dataUrl = await readFileAsDataUrl(f); } catch(e){}
    pendingFiles.push({ name: f.name, size: (f.size/1024).toFixed(0)+' KB', mime: f.type || mimeForExt(f.name), dataUrl, bytes: f.size });
    pendingFileHandles.push(f);
  }
  renderPending();
}
async function dropFiles(e){ e.preventDefault(); document.getElementById('dz')?.classList.remove('over'); const fs=[...e.dataTransfer.files]; pendingFiles=[]; pendingFileHandles=[]; for(const f of fs){ if(f.size > MAX_FILE_BYTES){ toast('⚠️ "'+f.name+'" supera 10 MB'); continue; } let dataUrl=''; try{ if(f.size <= INLINE_MAX_BYTES) dataUrl = await readFileAsDataUrl(f); }catch(_){} pendingFiles.push({ name:f.name, size:(f.size/1024).toFixed(0)+' KB', mime: f.type || mimeForExt(f.name), dataUrl, bytes: f.size }); pendingFileHandles.push(f); } renderPending(); }
function renderPending(){
  const box=document.getElementById('fileList'); if(!box) return;
  box.innerHTML=pendingFiles.map((f,i)=>`<div class="file-chip">📄 <b>${escHtml(f.name)}</b> <span style="color:#64748b">(${escHtml(f.size)})</span><button class="btn btn-danger btn-sm" onclick="pendingFiles.splice(${i},1);pendingFileHandles.splice(${i},1);renderPending()">✕</button></div>`).join('');
}
async function submitWork(activityId){
  if(!pendingFiles.length){toast('⚠️ Selecciona al menos un archivo');return;}
  const d=store(); const a=d.activities.find(x=>x.id===activityId);
  if(!a){toast('⚠️ Actividad no encontrada');return;}
  if(session.rol === 'estudiante' && !canAccessModule(a.curso)){ toastLocked(a.curso); navigate('cursos'); return; }
  const now=new Date(); const late=now>deadlineOf(a);
  if(late && !a.permitirTarde){toast('⚠️ Actividad vencida');render();return;}
  if(!supa){ toast('⚠️ Supabase no configurado: pega tu URL y anon key en app.js'); return; }
  toast('☁️ Subiendo a Supabase…');
  const prev = d.submissions.find(s=>s.activityId===activityId&&s.email===session.email);
  d.submissions=d.submissions.filter(s=>!(s.activityId===activityId&&s.email===session.email));
  const nuevos = [];
  for(let i=0;i<pendingFiles.length;i++){
    const f = pendingFiles[i];
    const handle = pendingFileHandles[i];
    let fileUrl = '', storagePath = '';
    // Supabase Storage: guarda el original (hasta 10MB)
    if(handle){
      try{
        const path = `${SUPA_WORK_PREFIX}/${activityId}/${sanitizePath(session.email)}/${Date.now()}_${sanitizePath(handle.name)}`;
        const up = await uploadFileToSupabase(SUPA_BUCKET, path, handle);
        fileUrl = up.url; storagePath = up.path;
      }catch(err){ console.warn('Supabase falló:', err); toast('⚠️ No se pudo subir "'+f.name+'". Revisa tu conexión y configuración.'); continue; }
    }
    nuevos.push({id:'s'+Date.now()+i+'_'+Math.floor(Math.random()*1e4),activityId,estudiante:session.nombre,email:session.email,fecha:now.toISOString(),archivo:f.name,tam:f.size,late,mime:f.mime||mimeForExt(f.name),dataUrl:'',fileUrl,storagePath,grade:(prev && prev.archivo===f.name && prev.grade!=null)?prev.grade:null,feedback:(prev && prev.archivo===f.name)?(prev.feedback||''):'',gradedAt:(prev && prev.archivo===f.name)?(prev.gradedAt||null):null,gradedBy:(prev && prev.archivo===f.name)?(prev.gradedBy||'') :''});
  }
  if(!nuevos.length){ return; }
  // NUBE PRIMERO para entregas: el docente las ve en cualquier dispositivo.
  let cloudOkCount = 0;
  for(const n of nuevos){
    try {
      d.submissions.push(n);
      const lite = Object.assign({}, n);
      if(lite.dataUrl && lite.dataUrl.length > 900000) delete lite.dataUrl;
      lite.actualizadoEn = new Date().toISOString();
      const ok = await cloudSave('submissions', n.id, lite);
      if(ok) cloudOkCount++;
    } catch(e){}
  }
  if(db && cloudOkCount === 0) toast('⚠️ Se guardó local pero la nube falló. El docente podría no verlo en otro dispositivo. Revisa tu conexión.');
  try{ saveStore(d); }catch(e){
    try{ nuevos.forEach(n=>{ n.dataUrl=''; }); const d2=store(); d2.submissions=d2.submissions.filter(s=>!(s.activityId===activityId&&s.email===session.email)); nuevos.forEach(n=>d2.submissions.push(n)); saveStore(d2); }catch(_){ toast('⚠️ No se pudo guardar (almacenamiento lleno)'); return; }
  }
  pendingFiles=[]; pendingFileHandles=[];
  toast(db ? '✅ Trabajo enviado y sincronizado con la nube' : '✅ Trabajo guardado local (sin nube)');
  navigate('confirmacion',activityId);
}
function viewConfirmacion(activityId){
  const a=store().activities.find(x=>x.id===activityId); const sub=mySubmission(activityId);
  if(!a || !sub) return '<div class="card">No existe</div>';
  if(session.rol === 'estudiante' && !canAccessModule(a.curso)) return viewBloqueado(a.curso);
  return `<div class="card" style="text-align:center;padding:40px">
    <div style="font-size:64px">✅</div><h2>✓ Trabajo presentado correctamente</h2>
    <p style="color:#64748b">${escHtml(a.titulo)} · ${courseOf(a.curso).nombre}</p>
    <div style="display:inline-block;text-align:left;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 22px">
      📅 Fecha de presentación: <b>${fmtFechaHora(sub.fecha)}</b><br>📄 Archivo: <b>${escHtml(sub.archivo)}</b> (${escHtml(sub.tam)})<br>Estado: <b>${sub.late?'⚠️ Fuera de plazo':'✓ Presentado a tiempo'}</b>
    </div><br><br>
    <button class="btn btn-primary" onclick="navigate('actividad','${a.id}')">Ver actividad</button>
    <button class="btn btn-outline" onclick="navigate('misentregas')">📤 Mis trabajos</button></div>`;
}
function viewMisEntregas(){
  // Solo trabajos de módulos habilitados (el bloqueado no muestra entregas ni notas)
  const actsById = {};
  store().activities.forEach(a => { actsById[a.id] = a; });
  const subs=store().submissions.filter(s=>s.email===session.email && actsById[s.activityId] && canAccessModule(actsById[s.activityId].curso));
  const prom = avgProm(subs);
  return `<h1 class="page-title">📤 Mis trabajos</h1><p class="page-sub">Historial de tus trabajos presentados. Promedio: <b>${prom}</b></p>
  <div class="card"><div class="table-wrap"><table><tr><th>Actividad</th><th>Módulo</th><th>Archivo</th><th>Fecha</th><th>Estado</th><th>Nota</th></tr>
  ${subs.map(s=>{const a=store().activities.find(x=>x.id===s.activityId);if(!a)return '';const g=gradeOf(s);return `<tr><td><b>${escHtml(a.titulo)}</b>${s.feedback?`<br><small style="color:#475569">💬 ${escHtml(s.feedback)}</small>`:''}</td><td>${courseOf(a.curso).nombre}</td><td>📄 ${escHtml(s.archivo)}<br><button class="btn btn-outline btn-sm" onclick="downloadSubmission('${s.id}')">⬇ Descargar</button></td><td>${fmtFechaHora(s.fecha)}</td><td>${badge(s.late?{key:'tarde',label:'Fuera de plazo'}:{key:'presentado',label:'Presentado'})}</td><td>${gradeBadge(s)}${g!=null&&s.gradedAt?`<br><small style="color:#64748b">${fmtFechaHora(s.gradedAt)}</small>`:''}</td></tr>`;}).join('')||'<tr><td colspan=6 style="text-align:center;color:#64748b">Aún no has presentado trabajos.</td></tr>'}</table></div></div>`;
}

/* ---------- 10. Trabajos docente ---------- */
function viewEntregas(){
  const {activities}=store();
  if(!activities.length){
    return `
    <h1 class="page-title">📤 Trabajos de estudiantes</h1>
    <p class="page-sub">Aquí gestionarás quién presentó cada actividad.</p>
    <div class="card" style="text-align:center;padding:36px">
      <div style="font-size:52px">📤</div>
      <h3>Sin actividades para revisar</h3>
      <p class="desc">Primero crea una actividad en su módulo correspondiente. Luego verás aquí la lista de estudiantes, su estado y sus archivos.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="navigate('crear','moviles')">📱 + En Móviles</button>
        <button class="btn btn-primary btn-sm" style="background:#f59e0b" onclick="navigate('crear','ensamblaje')">🛠️ + En Ensamblaje</button>
      </div>
    </div>`;
  }
  const sel=routeParam||activities.filter(a=>a.estado==='publicada')[0]?.id||activities[0]?.id;
  if(!routeParam&&sel) routeParam=sel;
  if(!activities.find(x=>x.id===sel)){
    routeParam = activities[0].id;
    return viewEntregas();
  }
  return `
  <h1 class="page-title">📤 Trabajos de estudiantes</h1>
  <p class="page-sub">Selecciona una actividad y revisa quién presentó.</p>
  <div class="card">
    <div class="field"><label>Actividad</label><select onchange="navigate('entregas',this.value)" aria-label="Seleccionar actividad">${activities.map(x=>`<option value="${x.id}" ${x.id===sel?'selected':''}>${courseOf(x.curso).nombre} — ${escHtml(x.titulo)} (⏰ ${fmtFecha(x.limite)})</option>`).join('')}</select></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div class="filters" style="margin:0">
        ${[['todos','Todos'],['presentados','Presentados'],['pendientes','Pendientes'],['tarde','Fuera de plazo']].map(([k,l])=>`<button class="${entregaFilter===k?'active':''}" onclick="entregaFilter='${k}';render()">${l}</button>`).join('')}
      </div>
      <input placeholder="🔍 Buscar estudiante…" value="${escHtml(entregaSearch)}" oninput="entregaSearch=this.value;renderEntregasRows('${sel}')" style="margin-left:auto;border:1px solid var(--border);border-radius:999px;padding:8px 14px;min-width:200px" aria-label="Buscar estudiante">
    </div>
    <div id="entRows" style="margin-top:12px"></div>
  </div>`;
}
/* Calcula una vez las filas de trabajos por estudiante (fuente única para
   viewEntregas y renderEntregasRows). Devuelve {a, rows}. */
function entregaRowsFor(sel){
  const a=store().activities.find(x=>x.id===sel);
  const all=store().submissions.filter(s=>s.activityId===sel);
  const q=(entregaSearch||'').toLowerCase();
  const rows=getAllStudents().map(st=>{
    const s=all.find(x=>x.email===st.email);
    let estado,fecha='—',arch='—';
    if(s){ estado=s.late?{key:'tarde',label:'Fuera de plazo'}:{key:'presentado',label:'Presentado'}; fecha=fmtFechaHora(s.fecha); arch=s.archivo; }
    else { estado=(a&&new Date()>deadlineOf(a))?{key:'vencido',label:'Vencido'}:{key:'pendiente',label:'Pendiente'}; }
    return {st,s,estado,fecha,arch};
  }).filter(r=>{
    if(q && !(r.st.nombre||'').toLowerCase().includes(q) && !(r.st.email||'').toLowerCase().includes(q)) return false;
    if(entregaFilter==='presentados') return !!r.s&&!r.s.late;
    if(entregaFilter==='pendientes') return !r.s && r.estado.key==='pendiente';
    if(entregaFilter==='tarde') return (!!r.s&&r.s.late)||(!r.s&&r.estado.key==='vencido');
    return true;
  });
  return { a, rows };
}
function renderEntregasRows(sel){
  const box=document.getElementById('entRows');
  if(!box){ render(); return; }
  // re-render de filas sin perder el select
  const { a, rows } = entregaRowsFor(sel);
  if(!a){ box.innerHTML='<div class="empty">Actividad no encontrada.</div>'; return; }
  box.innerHTML=`<div class="table-wrap"><table><tr><th>Estudiante</th><th>Estado</th><th>Fecha de presentación</th><th>Archivo</th><th>Nota</th><th>Acción</th></tr>
  ${rows.map(r=>`<tr><td><b>${escHtml(r.st.nombre)}</b><br><small style="color:#64748b">${escHtml(formatGradoSeccion(r.st))}</small></td><td>${badge(r.estado)}</td><td>${r.fecha}</td><td>${r.arch==='—'?'—':'📄 '+escHtml(r.arch)}</td><td>${r.s?gradeBadge(r.s):'—'}</td><td>${r.s?`<button class="btn btn-outline btn-sm" onclick="downloadSubmission('${r.s.id}')">⬇ Descargar</button> <button class="btn btn-ghost btn-sm" onclick="navigate('entrega-detalle','${r.s.id}')">Ver / Calificar</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan=6 style="text-align:center">Sin estudiantes todavía.<br><small>Aparecerán cuando se registren o presenten trabajos.</small></td></tr>'}</table></div>`;
}

/* ---------- 14. Detalle trabajo + calificación real ---------- */
function viewEntregaDetalle(sid){
  const s=store().submissions.find(x=>x.id===sid); if(!s) return '<div class="card">No existe el trabajo.</div>';
  const a=store().activities.find(x=>x.id===s.activityId); if(!a) return '<div class="card">La actividad de este trabajo fue eliminada.</div>';
  const g = gradeOf(s);
  return `<button class="btn btn-outline btn-sm" onclick="navigate('entregas','${a.id}')">← Volver a trabajos</button>
  <div class="card" style="margin-top:12px"><h2>📄 Detalle del trabajo</h2>
  <dl class="kv"><dt>Estudiante</dt><dd><b>${escHtml(s.estudiante)}</b> (${escHtml(s.email)})</dd><dt>Actividad</dt><dd>${escHtml(a.titulo)}</dd><dt>Módulo</dt><dd>${courseOf(a.curso).nombre}</dd><dt>Archivo</dt><dd>📄 ${escHtml(s.archivo)} (${escHtml(s.tam)})</dd><dt>Fecha de presentación</dt><dd>${fmtFechaHora(s.fecha)}</dd><dt>Límite</dt><dd>${fmtFecha(a.limite)} · ${fmtHora12(a.hora)}</dd><dt>Estado</dt><dd>${badge(s.late?{key:'tarde',label:'Fuera de plazo'}:{key:'presentado',label:'Presentado a tiempo'})}</dd><dt>Nota actual</dt><dd>${gradeBadge(s)}${g!=null&&s.gradedAt?` <small style="color:#64748b">(${fmtFechaHora(s.gradedAt)})</small>`:''}</dd></dl>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="downloadSubmission('${s.id}')">⬇ Descargar archivo</button></div></div>
  <div class="card"><h3>⭐ Calificar trabajo</h3><p class="desc">La nota se guarda y el estudiante la verá en su cuenta (Mis trabajos, actividad y perfil).</p>
    <div class="form-grid">
      <div class="field"><label>Nota (0 – 20)</label><input id="gradeInput" type="number" min="0" max="20" step="0.5" value="${g!=null?g:''}" placeholder="Ej. 17"></div>
      <div class="field"><label>Comentario / retroalimentación</label><input id="gradeFeedback" value="${escHtml(s.feedback)}" placeholder="Ej. Buen trabajo, revisa la portada"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-success btn-sm" onclick="saveGrade('${s.id}')">✅ Guardar calificación</button>
      ${g!=null?`<button class="btn btn-outline btn-sm" onclick="clearGrade('${s.id}')">🗑 Quitar nota</button>`:''}
    </div>
  </div>`;
}

/* ---------- Estudiantes / Perfil / Config ---------- */
let estSearch = '';
let estGradoFilter = '';
let estSeccionFilter = '';
function viewEstudiantes(){
  const allSt = getAllStudents();
  const grados = [...new Set(allSt.map(s=>s.grado).filter(Boolean))].sort();
  const secciones = [...new Set(allSt.map(s=>s.seccion).filter(Boolean))].sort();
  let head = `<h1 class="page-title">👥 Gestión de estudiantes</h1>
  <p class="page-sub">${allSt.length} estudiantes · visualiza correo, grado, sección y contraseña temporal · restablece en caso de olvido.</p>
  <div class="alert alert-yellow">🔒 <b>Nota de seguridad:</b> Firebase Auth no permite ver la contraseña real del estudiante. Aquí se muestra la <b>contraseña temporal</b> generada al restablecer. El estudiante recibirá una notificación para <b>conservarla o crear una nueva</b>.</div>`;
  if(!allSt.length){
    return head + `
    <div class="card" style="text-align:center;padding:36px">
      <div style="font-size:52px">👥</div>
      <h3>Aún no hay estudiantes registrados</h3>
      <p class="desc">Cuando un estudiante cree su cuenta en Firebase aparecerá aquí con su grado y sección. También aparecerá al presentar su primer trabajo.</p>
    </div>`;
  }
  return head + `
  <div class="card">
    <div class="est-toolbar">
      <input id="estSearch" placeholder="🔍 Buscar por nombre o correo…" value="${escHtml(estSearch)}" oninput="estSearch=this.value;renderEstudiantesRows()" aria-label="Buscar estudiante por nombre o correo">
      <select id="estGrado" onchange="estGradoFilter=this.value;renderEstudiantesRows()">
        <option value="">Todos los grados</option>
        ${grados.map(g=>`<option value="${g}" ${estGradoFilter===g?'selected':''}>${g}</option>`).join('')}
      </select>
      <select id="estSeccion" onchange="estSeccionFilter=this.value;renderEstudiantesRows()">
        <option value="">Todas las secciones</option>
        ${secciones.map(s=>`<option value="${s}" ${estSeccionFilter===s?'selected':''}>Sección ${s}</option>`).join('')}
      </select>
      <button class="btn btn-outline btn-sm" onclick="estSearch='';estGradoFilter='';estSeccionFilter='';render()">✕ Limpiar</button>
    </div>
    <div id="estRows" style="margin-top:12px"></div>
  </div>`;
}
function resetBadgeFor(st){
  const r = getLatestReset(st.email);
  if(!r) return `<span class="badge b-gray">Sin restablecimiento</span>`;
  if(r.status === 'pendiente') return `<span class="badge b-yellow">🟡 Pendiente de decisión</span>`;
  if(r.status === 'conservada') return `<span class="badge b-green">✅ Temporal conservada</span>`;
  return `<span class="badge b-blue">🔑 Personalizada</span>`;
}
function renderEstudiantesRows(){
  const box = document.getElementById('estRows');
  const allSt = getAllStudents();
  if(!box){ return; }
  const q = (estSearch || '').toLowerCase();
  const rows = allSt.filter(st=>{
    if(estGradoFilter && st.grado !== estGradoFilter) return false;
    if(estSeccionFilter && st.seccion !== estSeccionFilter) return false;
    if(q && !(st.nombre.toLowerCase().includes(q) || st.email.toLowerCase().includes(q))) return false;
    return true;
  });
  if(!rows.length){ box.innerHTML = '<div class="empty">Sin resultados con esos filtros.</div>'; return; }
  const pubCount = store().activities.filter(a=>a.estado==='publicada').length;
  box.innerHTML = `<div class="table-wrap"><table class="est-table">
  <tr><th>Estudiante / Correo</th><th>Grado</th><th>Sección</th><th>🔑 Contraseña</th><th>Estado clave</th><th>Rendimiento</th><th>Acción</th></tr>
  ${rows.map(st=>{
    const subs = store().submissions.filter(s=>s.email.toLowerCase()===st.email.toLowerCase());
    const n = subs.length;
    const prom = avgProm(subs);
    const r = getLatestReset(st.email);
    let pwdCell;
    if(r && r.status !== 'personalizada'){
      pwdCell = `<div class="pwd-cell"><code id="pwd_${r.id}" data-pwd="${r.tempPassword}" data-hidden="1">••••••••</code>
        <div class="pwd-btns">
          <button id="eye_${r.id}" class="btn btn-outline btn-sm" title="Mostrar / ocultar" onclick="toggleTempPwd('${r.id}')">👁️</button>
          <button class="btn btn-ghost btn-sm" title="Copiar" onclick="copyTempPwd('${r.tempPassword}')">📋</button>
        </div><small>Temp. ${fmtFechaHora(r.createdAt)}</small></div>`;
    } else if(r && r.status === 'personalizada'){
      pwdCell = `<small style="color:#64748b">🔑 Personalizada por el estudiante<br>${r.resolvedAt?fmtFechaHora(r.resolvedAt):''}</small>`;
    } else {
      pwdCell = `<small style="color:#64748b">•••••• oculta<br>(Firebase no la expone)</small>`;
    }
    return `<tr>
      <td><b>${escHtml(st.nombre)}</b><br><small>📧 ${escHtml(st.email)}</small></td>
      <td><span class="badge b-purple">${escHtml(st.grado) || '—'}</span></td>
      <td><span class="badge b-blue">${escHtml(st.seccion) || '—'}</span></td>
      <td>${pwdCell}</td>
      <td>${resetBadgeFor(st)}${r?`<br><small style="color:#64748b">${r.status==='pendiente'?'Notificado, esperando decisión':('Decidió: '+(r.decision==='nueva'?'crear nueva':'conservar'))}</small>`:''}</td>
      <td>📥 ${n} · ⭐ ${prom}<br><small style="color:#64748b">${Math.max(pubCount-n,0)} pendientes</small></td>
      <td><button class="btn btn-primary btn-sm" onclick="resetStudentPassword('${escJs(st.email)}')">🔑 Restablecer</button>
      ${r&&r.status!=='pendiente'?`<br><small style="color:#64748b">Última: ${fmtFechaHora(r.createdAt)}</small>`:''}</td>
    </tr>`;
  }).join('')}</table></div>
  <p class="desc" style="margin-top:10px">Al restablecer se genera una temporal y se envía una notificación al estudiante para que decida si <b>crea una nueva</b> o <b>conserva la temporal</b>.</p>`;
}
/* ---------- Notificaciones de contraseñas ---------- */
function viewNotificaciones(){
  if(session.rol === 'docente'){
    const all = getPwdResets().sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const pend = all.filter(r=>r.status==='pendiente').length;
    // Solo información vigente de Firestore: excluye avisos y notas de
    // actividades borradas o inexistentes (no deben reaparecer).
    let delN = null, validN = null;
    try { delN = getDeletedActivityIds(); validN = validActivityIdSet(); } catch(e){}
    const isLiveN = (aid, nid) => {
      if(aid && delN && delN.has(aid)) return false;
      if(nid && delN && delN.has(nid)) return false;
      if(aid && validN && validN.size && !validN.has(aid)) return false;
      return true;
    };
    const gradesLive = getGradeNotifs()
      .filter(n => isLiveN(n.activityId, null));
    const broadcastsLive = getActivityNotifs()
      .filter(n => isLiveN(n.activityId || (n.id||'').replace(/^an_/,'') , n.id));
    const grades = [...gradesLive].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,30);
    const broadcasts = [...broadcastsLive].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,20);
    return `<h1 class="page-title">🔔 Notificaciones</h1>
    <p class="page-sub">${all.length} restablecimientos (${pend} pendientes) · ${gradesLive.length} calificaciones notificadas · ${broadcastsLive.length} avisos de actividad.</p>
    <div class="alert ${_cloudStatus==='conectado'?'alert-green':'alert-yellow'}" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px">${_cloudStatus==='conectado'?'☁️ Nube conectada: tus publicaciones y calificaciones llegan a todos los dispositivos en tiempo real.':'⚠️ Estado nube: '+_cloudStatus+'. Pulsa Actualizar y revisa conexión / reglas.'}</span><button class="btn btn-outline btn-sm" onclick="pullAllCloudData(true)">🔄 Actualizar</button></div>
    <div class="card"><h3>📚 Avisos de actividad enviados</h3>
      <p class="desc">Cada actividad publicada genera un aviso automático a los estudiantes (llega a cualquier dispositivo).</p>
      ${!broadcasts.length?'<div class="empty">Aún no hay avisos. Publica una actividad y aparecerá aquí.</div>':
      `<div class="table-wrap"><table><tr><th>Actividad</th><th>Módulo</th><th>Límite</th><th>Fecha aviso</th></tr>
      ${broadcasts.map(n=>`<tr><td><b>${escHtml(n.activityTitle)}</b></td>
        <td>${escHtml(courseOf(n.module).corto||'')}</td>
        <td><small>${n.limite?fmtFecha(n.limite)+' '+(n.hora||''):''}</small></td>
        <td><small>${fmtFechaHora(n.createdAt)}</small></td></tr>`).join('')}</table></div>`}
    </div>
    <div class="card"><h3>⭐ Calificaciones notificadas a estudiantes</h3>
      <p class="desc">Cada vez que calificas un trabajo se le avisa al estudiante automáticamente.</p>
      ${!grades.length?'<div class="empty">Aún no notificas calificaciones. Califica un trabajo y aparecerá aquí.</div>':
      `<div class="table-wrap"><table><tr><th>Estudiante</th><th>Actividad</th><th>Nota</th><th>Fecha</th><th>Estado</th></tr>
      ${grades.map(n=>`<tr><td><b>${escHtml(n.studentName)}</b><br><small>${escHtml(n.studentEmail)}</small></td>
        <td>${escHtml(n.activityTitle)}<br><small style="color:#64748b">${escHtml(courseOf(n.module).corto||'')}</small></td>
        <td><b>⭐ ${n.grade}/20</b>${n.feedback?`<br><small>💬 ${escHtml(n.feedback)}</small>`:''}</td>
        <td><small>${fmtFechaHora(n.createdAt)}</small></td>
        <td>${n.read?'<span class="badge b-green">✅ Leída</span>':'<span class="badge b-yellow">🟡 Sin leer</span>'}</td></tr>`).join('')}</table></div>`}
    </div>
    <div class="card"><h3>🔑 Restablecimientos de contraseña</h3>
    <p class="desc">${all.length} restablecimientos · ${pend} pendientes de decisión del estudiante.</p>
    ${!all.length?`<div style="text-align:center;padding:20px"><div style="font-size:40px">🔔</div><h3>Sin restablecimientos</h3><p class="desc">Ve a 👥 Estudiantes y pulsa “🔑 Restablecer” cuando un estudiante olvide su contraseña.</p><button class="btn btn-primary btn-sm" onclick="navigate('estudiantes')">Ir a estudiantes</button></div>`:`
    <div class="table-wrap"><table><tr><th>Estudiante</th><th>Temporal enviada</th><th>Fecha</th><th>Decisión</th><th>Acción</th></tr>
    ${all.map(r=>`<tr><td><b>${r.studentName}</b><br><small>${r.studentEmail} · ${r.grado||''} ${r.seccion||''}</small></td>
      <td><code>${r.status==='personalizada'?'•••••• (personalizada)':r.tempPassword}</code></td>
      <td><small>${fmtFechaHora(r.createdAt)}</small>${r.resolvedAt?`<br><small style="color:#16a34a">Decidió: ${fmtFechaHora(r.resolvedAt)}</small>`:''}</td>
      <td>${r.status==='pendiente'?'<span class="badge b-yellow">🟡 Esperando al estudiante</span>':(r.status==='conservada'?'<span class="badge b-green">✅ Conservó temporal</span>':'<span class="badge b-blue">🔑 Creó nueva</span>')}</td>
      <td>${r.status==='pendiente'?'<span style="color:#64748b;font-size:13px">Notificado</span>':`<button class="btn btn-outline btn-sm" onclick="resendReset('${r.id}')">📨 Reenviar</button>`}</td></tr>`).join('')}</table></div>`}</div>`;
  }
  // Estudiante
  const mine = getResetsFor(session.email).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  const pendList = mine.filter(r=>r.status==='pendiente');
  const hist = mine.filter(r=>r.status!=='pendiente');
  const gAll = myGradeNotifs();
  const gUnread = gAll.filter(n=>!n.read);
  const gRead = gAll.filter(n=>n.read);
  const aAll = myActivityNotifs();
  const aUnread = aAll.filter(n=>!n.read);
  const aRead = aAll.filter(n=>n.read);
  return `<div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:200px"><h1 class="page-title">🔔 Mis notificaciones</h1>
  <p class="page-sub">Te avisamos cuando se publica una actividad, cuando tu trabajo ya fue calificado y si tu contraseña fue restablecida.</p></div>
  <button class="btn btn-outline btn-sm" onclick="pullStudentNotifs(true)">🔄 Actualizar</button></div>
  <div class="alert ${_cloudStatus==='conectado'?'alert-green':'alert-yellow'}" style="margin-bottom:14px">${_cloudStatus==='conectado'?'☁️ Conectado a la nube: tus actividades se sincronizan en tiempo real en todos tus dispositivos.':'⚠️ Estado nube: '+_cloudStatus+'. Si ves este aviso, pulsa 🔄 Actualizar y revisa tu conexión / reglas de Firestore.'}</div>
  ${(!mine.length && !gAll.length && !aAll.length)?`<div class="card" style="text-align:center;padding:32px"><div style="font-size:48px">🔕</div><h3>Sin notificaciones</h3><p class="desc">Cuando tu docente publique una actividad o califique un trabajo te llegará aquí. Si olvidas tu contraseña, pídele que la restablezca.</p></div>`:''}
  ${aUnread.length?`<div class="card" style="border-left:5px solid #4f46e5"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="flex:1;margin:0">📚 Nuevas actividades (${aUnread.length})</h3><button class="btn btn-outline btn-sm" onclick="markAllActivitiesRead()">✅ Marcar todas como leídas</button></div>
    ${aUnread.map(n=>`
    <div class="card notif-card" style="border-left-color:#4f46e5">
      <div class="notif-ico" style="background:#ede9fe">📚</div>
      <div style="flex:1;min-width:0">
        <h3 style="margin:0">¡Nueva actividad publicada!</h3>
        <p class="desc"><b>${escHtml(n.activityTitle)}</b> · ${escHtml(courseOf(n.module).nombre||'')} · ${n.limite?('⏰ Límite: '+fmtFecha(n.limite)+' '+(n.hora||'')):'Sin fecha límite visible'}</p>
        ${n.descripcion?`<p class="desc">${escHtml(n.descripcion)}</p>`:''}
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          ${n.activityId?`<button class="btn btn-primary btn-sm" onclick="navigate('actividad','${n.activityId}')">Ver actividad →</button>`:''}
          <button class="btn btn-outline btn-sm" onclick="markActivityNotifRead('${n.id}')">✅ Marcar como leída</button>
        </div>
      </div>
    </div>`).join('')}</div>`:''}
  ${aRead.length?`<div class="card"><h3>📜 Actividades anteriores</h3>${aRead.slice(0,10).map(n=>`<div class="file-chip">📚 <b>${escHtml(n.activityTitle)}</b> · ${escHtml(courseOf(n.module).corto||'')}<span style="color:#64748b;font-size:12px">${n.createdAt?fmtFechaHora(n.createdAt):''} · leída</span>${n.activityId?`<button class="btn btn-outline btn-sm" onclick="navigate('actividad','${n.activityId}')">Ver</button>`:''}</div>`).join('')}</div>`:''}
  ${gUnread.length?`<div class="card" style="border-left:5px solid #16a34a"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="flex:1;margin:0">⭐ Trabajos calificados (${gUnread.length} nuevos)</h3><button class="btn btn-outline btn-sm" onclick="markAllGradesRead()">✅ Marcar todas como leídas</button></div>
    ${gUnread.map(n=>`
    <div class="card notif-card" style="border-left-color:#16a34a">
      <div class="notif-ico" style="background:#dcfce7">⭐</div>
      <div style="flex:1;min-width:0">
        <h3 style="margin:0">¡Tu trabajo ya fue calificado!</h3>
        <p class="desc"><b>${escHtml(n.activityTitle)}</b> · ${escHtml(courseOf(n.module).nombre||'')} · calificado el ${fmtFechaHora(n.gradedAt||n.createdAt)}</p>
        <div class="alert alert-green" style="margin:0">Nota: <b style="font-size:18px">⭐ ${n.grade}/20</b>${n.feedback?`<br>💬 Comentario: ${escHtml(n.feedback)}`:''}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          ${n.activityId?`<button class="btn btn-primary btn-sm" onclick="navigate('actividad','${n.activityId}')">Ver actividad →</button>`:''}
          <button class="btn btn-outline btn-sm" onclick="markGradeNotifRead('${n.id}')">✅ Marcar como leída</button>
        </div>
      </div>
    </div>`).join('')}</div>`:''}
  ${gRead.length?`<div class="card"><h3>📜 Calificaciones anteriores</h3>${gRead.slice(0,10).map(n=>`<div class="file-chip">⭐ <b>${escHtml(n.activityTitle)}</b> · ${n.grade}/20${n.feedback?` · 💬 ${escHtml(n.feedback)}`:''}<span style="color:#64748b;font-size:12px">${fmtFechaHora(n.gradedAt||n.createdAt)} · leída</span>${n.activityId?`<button class="btn btn-outline btn-sm" onclick="navigate('actividad','${n.activityId}')">Ver</button>`:''}</div>`).join('')}</div>`:''}
  ${mine.length?`<div class="card"><h3>🔑 Contraseñas</h3><p class="desc">Si tu docente restablece tu contraseña, decide aquí si la conservas o creas una nueva.</p></div>`:''}
  ${pendList.map(r=>`
  <div class="card notif-card">
    <div class="notif-ico">🔑</div>
    <div style="flex:1;min-width:0">
      <h3 style="margin:0">Tu contraseña fue restablecida</h3>
      <p class="desc">El docente (${r.createdBy||'docente'}) generó una contraseña temporal el ${fmtFechaHora(r.createdAt)}. Decide qué hacer:</p>
      <div class="alert alert-blue">Temporal asignada: <code style="font-size:16px"><b>${r.tempPassword}</b></code>
        <button class="btn btn-outline btn-sm" onclick="copyTempPwd('${r.tempPassword}')">📋 Copiar</button></div>
      <div class="grid2" style="margin-top:10px">
        <div class="decision-box">
          <b>✅ Opción 1 · Conservar temporal</b>
          <p class="desc">Seguirás ingresando con <code>${r.tempPassword}</code>.</p>
          <button class="btn btn-success btn-sm" onclick="studentResolveReset('${r.id}','conservar')">✅ Conservar temporal</button>
        </div>
        <div class="decision-box">
          <b>✏️ Opción 2 · Crear nueva</b>
          <p class="desc">Escribe tu propia contraseña (mín. 6 caracteres).</p>
          <div style="display:flex;gap:8px"><input id="newPwd_${r.id}" type="password" placeholder="Mi nueva contraseña" style="flex:1;border:1px solid var(--border);border-radius:10px;padding:10px 12px">
          <button class="btn btn-primary btn-sm" onclick="studentResolveReset('${r.id}','nueva')">Guardar nueva</button></div>
        </div>
      </div>
    </div>
  </div>`).join('')}
  ${hist.length?`<div class="card"><h3>📜 Historial de decisiones</h3>${hist.map(r=>`<div class="file-chip">✅ <b>${r.decision==='nueva'?'Creaste una nueva contraseña':'Conservaste la temporal'}</b><span style="color:#64748b;font-size:12.5px">${fmtFechaHora(r.resolvedAt||r.createdAt)}${r.appliedInAuth?' · aplicada en tu cuenta':''}</span></div>`).join('')}</div>`:''}`;
}
function pendingPwdBanner(){
  const p = myPendingResets();
  if(!p.length) return '';
  const r = p[0];
  return `<div class="alert alert-yellow">🔑 <b>Tu docente restableció tu contraseña</b> (temporal: <code><b>${r.tempPassword}</b></code>). Decide si la conservas o creas una nueva aquí: <button class="btn btn-primary btn-sm" onclick="navigate('notificaciones')">Decidir ahora →</button>${p.length>1?` <small>(+${p.length-1} pendientes)</small>`:''}</div>`;
}
function pendingGradeBanner(){
  let unread = [];
  try { unread = myUnreadGradeNotifs(); } catch(e){ unread = []; }
  if(!unread.length) return '';
  const n = unread[0];
  return `<div class="alert alert-green">⭐ <b>Tu trabajo ya fue calificado:</b> ${escHtml(n.activityTitle)} → <b>${n.grade}/20</b>${n.feedback?` · 💬 ${escHtml(n.feedback)}`:''} <button class="btn btn-success btn-sm" onclick="navigate('notificaciones')">Ver notificación →</button>${unread.length>1?` <small>(+${unread.length-1} más)</small>`:''}</div>`;
}
function studentAlertBanners(){
  return pendingActivityBanner() + pendingPwdBanner() + pendingGradeBanner();
}
function viewPerfil(){
  const isDoc=session.rol==='docente';
  const actsByIdP = {};
  if(!isDoc) store().activities.forEach(a => { actsByIdP[a.id] = a; });
  const subs=isDoc?[]:store().submissions.filter(s=>s.email===session.email && actsByIdP[s.activityId] && canAccessModule(actsByIdP[s.activityId].curso));
  const prom=!isDoc?avgProm(subs):'';
  return `<h1 class="page-title">👤 ${isDoc?'Mi perfil':'Mi perfil'}</h1><p class="page-sub">Información de tu cuenta.</p>
  <div class="card"><div class="profile-head"><div class="avatar" style="background:${isDoc?'#7c3aed':'#0891b2'}">${session.nombre[0]}</div>
  <div><h2 style="margin:0">${displayName()}</h2><p style="margin:2px 0;color:#64748b">${escHtml(session.email)} · ${isDoc?'Docente':('Estudiante · Grado: '+escHtml(session.grado||'—')+' · Sección: '+escHtml(session.seccion||'—')+(prom!=='—'?' · ⭐ Promedio: '+prom:''))}</p><span class="pill-role">${session.rol.toUpperCase()}${!isDoc&&formatGradoSeccion(session)?' · '+formatGradoSeccion(session):''}</span></div></div>
  <div class="field" style="margin-top:14px"><label>Nombre para mostrar</label><input id="pf_name" value="${escHtml(session.nombre)}"></div>
  <button class="btn btn-primary btn-sm" onclick="session.nombre=document.getElementById('pf_name').value;document.getElementById('miniName').textContent=session.nombre;toast('✅ Perfil actualizado')">Guardar cambios</button></div>
  ${!isDoc?`<div class="card"><h3>📊 Mi progreso</h3><p class="desc">${subs.length} trabajos presentados · ${subs.filter(s=>gradeOf(s)!=null).length} calificados · ⭐ Promedio: <b>${prom}</b> · Grado ${session.grado||'—'} · Sección ${session.seccion||'—'}.</p>${subs.map(s=>{const a=store().activities.find(x=>x.id===s.activityId);return `<div class="file-chip">📄 ${a?escHtml(a.titulo):''} — ${escHtml(s.archivo)} ${badge(s.late?{key:'tarde',label:'Tardía'}:{key:'presentado',label:'A tiempo'})} ${gradeBadge(s)}${s.feedback?`<br><small>💬 ${escHtml(s.feedback)}</small>`:''}</div>`;}).join('')||'<div class="empty">Sin trabajos.</div>'}</div>`:''}`;
}
function viewConfig(){
  const c=store().config||{};
  return `<h1 class="page-title">⚙️ Configuración básica</h1><p class="page-sub">Preferencias simples de la plataforma.</p>
  <div class="card">
    <label style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)"><input type="checkbox" ${c.notif?'checked':''} onchange="updCfg('notif',this.checked)"> 🔔 Notificarme cuando llegue un trabajo</label>
    <label style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)"><input type="checkbox" ${c.resumen?'checked':''} onchange="updCfg('resumen',this.checked)"> 📧 Recibir resumen semanal por correo</label>
    <label style="display:flex;gap:10px;align-items:center;padding:10px 0"><input type="checkbox" ${c.tarde?'checked':''} onchange="updCfg('tarde',this.checked)"> ⏰ Permitir trabajos tardíos por defecto</label>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="toast('✅ Configuración guardada')">Guardar</button><button class="btn btn-outline btn-sm" onclick="if(confirm('¿Borrar TODAS las actividades y trabajos? Empezarás desde cero.')){resetAllData();location.reload()}">🗑 Borrar todo y empezar de cero</button></div>
  </div>
  <div class="card"><h3>☁️ Conexión con Firebase / Firestore</h3>
    <p class="desc">La sincronización multi-dispositivo depende de Firestore. Si un estudiante no ve actividades en otro dispositivo, verifica aquí.</p>
    <dl class="kv"><dt>Estado</dt><dd><b>${_cloudStatus}</b></dd><dt>Proyecto</dt><dd>${firebaseConfig.projectId}</dd><dt>Última sync</dt><dd>${_lastFullSyncAt ? fmtFechaHora(_lastFullSyncAt) : 'nunca'}</dd><dt>Actividades en caché</dt><dd>${store().activities.length} · Entregas: ${store().submissions.length} · Avisos: ${getActivityNotifs().length}</dd></dl>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn btn-primary btn-sm" onclick="checkFirebaseConnection().then(r=>{toast(r.ok?'✅ Conectado a Firestore':'⚠️ Falló: '+(r.reason||''));render()})">🔌 Probar conexión</button>
      <button class="btn btn-outline btn-sm" onclick="pullAllCloudData(true)">🔄 Sincronizar ahora</button>
    </div>
    <div class="alert alert-yellow" style="margin:12px 0 0">🔐 Si la prueba dice <b>permission-denied</b>, en Firebase Console → Firestore → Rules permite al menos:<br><code>match /activities/{id} { allow read, write: if request.auth != null; }</code><br><code>match /submissions/{id} { allow read, write: if request.auth != null; }</code><br><code>match /activity_notifications/{id} { allow read, write: if request.auth != null; }</code><br><code>match /grade_notifications/{id} { allow read, write: if request.auth != null; }</code><br><code>match /password_resets/{id} { allow read, write: if request.auth != null; }</code><br><code>match /deleted_activities/{id} { allow read, write: if request.auth != null; }</code><br><code>match /users/{id} { allow read, write: if request.auth != null; }</code></div>
  </div>`;
}
function updCfg(k,v){ const d=store(); d.config[k]=v; saveStore(d); toast('✅ Guardado'); }

/* ---------- Persistencia de sesión Firebase + Enter ---------- */
document.getElementById('loginPass')?.addEventListener('keydown', e => {
  if(e.key === 'Enter'){ authMode === 'register' ? doRegister() : doLogin(); }
});
/* ---------- Arranque: restaura sesión sin mostrar el login ----------
   Orden: 1) sesión guardada → entra de inmediato. 2) Firebase confirma
   en segundo plano (respeta rol real de Firestore). 3) Sin sesión válida → login. */
let _authFirstEvent = false;
function waitFirstAuthEvent(timeoutMs){
  return new Promise((resolve) => {
    if(!auth){ resolve(null); return; }
    let done = false;
    const timer = setTimeout(() => { if(!done){ done = true; resolve(undefined); } }, timeoutMs || 6000);
    const unsub = auth.onAuthStateChanged((user) => {
      if(done) return; done = true;
      clearTimeout(timer);
      try { unsub(); } catch(e){}
      _authFirstEvent = true;
      resolve(user || null);
    });
  });
}
async function reconcileWithFirebase(fbUser, cached){
  // Devuelve true si quedó dentro de la app, false si debe verse el login
  if(fbUser){
    try {
      const snap = await db.collection('users').doc(fbUser.uid).get();
      if(!snap.exists){
        // Cuenta sin ficha de rol: no se puede determinar permisos → fuera
        try { await auth.signOut(); } catch(e){}
        clearPersistedSession();
        showLogin();
        return false;
      }
      const perfil = snap.data();
      rememberExtraUser(perfil);
      // El rol de Firestore manda (respeta permisos docente/estudiante)
      if(session && session.uid === fbUser.uid && session.rol === perfil.rol && (session.email||'').toLowerCase() === (perfil.email||'').toLowerCase()){
        // Misma sesión ya restaurada: actualiza datos en silencio SIN sacarlo de donde está
        session.nombre = perfil.nombre; session.grado = perfil.grado || ''; session.seccion = perfil.seccion || ''; session.curso = perfil.curso || '';
        persistSession(session);
        try {
          document.getElementById('miniName').textContent = session.nombre + (session.rol==='estudiante' && formatGradoSeccion(session) ? ' · ' + formatGradoSeccion(session) : '');
          document.getElementById('miniMail').textContent = session.email;
        } catch(e){}
        return true;
      }
      enterApp({ nombre: perfil.nombre, email: perfil.email, rol: perfil.rol, grado: perfil.grado || '', seccion: perfil.seccion || '', curso: perfil.curso || '', uid: fbUser.uid });
      return true;
    } catch(e){
      console.warn('Reconciliación Firebase falló:', e);
      // Sin red para validar: si había caché válida, se mantiene dentro
      if(cached && !session) enterApp(cached);
      else if(!session) showLogin();
      return !!session;
    }
  }
  // Firebase dice: no hay usuario autenticado
  if(cached && cached.uid){
    // La sesión de Firebase expiró o se cerró en otro lado → fuera, al login
    clearPersistedSession();
    showLogin();
    return false;
  }
  if(cached && !cached.uid){
    // Sesión local offline (modo sin Firebase): se mantiene
    if(!session) enterApp(cached);
    return true;
  }
  showLogin();
  return false;
}
async function boot(){
  const cached = getPersistedSession();
  if(cached){
    // Restaura al instante: el usuario NUNCA ve el login al recargar
    enterApp(cached);
    if(auth && db){
      // Confirma en segundo plano sin sacar al usuario salvo que deba salir
      waitFirstAuthEvent(8000).then((fbUser) => {
        if(fbUser === undefined) return; // Firebase colgado/offline: se queda con la caché
        if(fbUser && fbUser.email && fbUser.email.toLowerCase() === cached.email.toLowerCase()){
          // Mismo usuario: valida rol actual por si cambió en Firestore
          reconcileWithFirebase(fbUser, cached);
        } else if(fbUser){
          // Otro usuario autenticado en este navegador: manda Firebase
          reconcileWithFirebase(fbUser, cached);
        } else {
          reconcileWithFirebase(null, cached);
        }
      });
    }
    return;
  }
  // Sin caché: espera a Firebase (inicio fresco) y decide
  if(auth && db){
    const fbUser = await waitFirstAuthEvent(6000);
    if(fbUser === undefined || fbUser === null){ showLogin(); return; }
    await reconcileWithFirebase(fbUser, null);
    return;
  }
  // Sin Firebase (SDK bloqueado/offline total): directo al login
  showLogin();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
