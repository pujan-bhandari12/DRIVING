// Driving Training Center — client-side app with server sync and fallback
(function(){
  const LS = {
    students: 'dtc_students',
    attendance: 'dtc_attendance',
    unsynced_att: 'dtc_unsynced_att',
    deleted_att: 'dtc_deleted_att',
    payments: 'dtc_payments'
  };

  // POS/cart removed — cart variable and product flow intentionally omitted
  let serverOnline = false;
  let manualSelectedId = null;
  // debug flag: set to true to enable debug logs in development
  const DEBUG = false;
  function dbg(){ if(DEBUG) try{ console.log.apply(console, arguments); }catch(e){} }
  // debounce helper
  function debounce(fn, wait=250){ let t; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); } }

  const $ = s=>document.querySelector(s);
  const $$ = s=>Array.from(document.querySelectorAll(s));

  function read(key){ try{ return JSON.parse(localStorage.getItem(key) || '[]'); }catch(e){return []} }
  function readObj(key){ try{ return JSON.parse(localStorage.getItem(key) || '{}'); }catch(e){return {}} }
  function write(key,val){ localStorage.setItem(key, JSON.stringify(val)); }

  function uid(pref='id'){ return pref+'_'+Math.random().toString(36).slice(2,9); }

  // Receipt number generator: keeps a sequential counter in localStorage and returns a formatted receipt id
  function getNextReceiptNumber(){
    try{
      const key = 'dtc_receipt_seq';
      let seq = Number(localStorage.getItem(key) || '0');
      seq = seq + 1;
      localStorage.setItem(key, String(seq));
      // format: R-YYYYMMDD-XXXX (zero-padded sequence)
      const d = new Date();
      const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const day = String(d.getDate()).padStart(2,'0');
      const seqStr = String(seq).padStart(4,'0');
      return `R-${y}${m}${day}-${seqStr}`;
    }catch(e){ return 'R-' + Date.now(); }
  }

  // normalize a full name into Title Case (each word first letter uppercase, rest lowercase)
  function titleCase(name){
    if(!name) return '';
    return String(name).trim().split(/\s+/).map(w=>{
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  }

  // safe HTML escape utility used across modals and lists
  function escapeHtml(s){
    if(s===undefined || s===null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // date range helper: checks if an ISO datetime (item.time) falls between start/end (YYYY-MM-DD) inclusive
  function dateInRange(isoTime, startYMD, endYMD){
    if(!isoTime) return false;
    const d = isoTime.slice(0,10);
    if(startYMD && d < startYMD) return false;
    if(endYMD && d > endYMD) return false;
    return true;
  }

  async function pingServer(){
    // when opened over file:// the browser blocks fetch to /api (CORS/protocol issues).
    // Detect that case and skip attempting the network call so the app doesn't spam the console with errors.
    if(location && location.protocol === 'file:'){
      serverOnline = false; updateServerStatus(); return false;
    }
    try{
      const headers = {};
      const key = localStorage.getItem('dtc_sync_key'); if(key) headers['x-api-key'] = key;
      const res = await fetch('/api/ping',{cache:'no-cache', headers});
      const j = await res.json(); serverOnline = !!j.ok; updateServerStatus(); return true;
    }catch(e){ serverOnline=false; updateServerStatus(); return false; }
  }

  function updateServerStatus(){
    const el = $('#server-status'); if(!el) return; el.textContent = serverOnline ? 'Server: online' : 'Server: offline (using local mode)'; el.className = serverOnline? 'accent':'';
  }

  async function fetchState(){
    if(!await pingServer()) return false;
    try{
      const headers = {};
      const key = localStorage.getItem('dtc_sync_key'); if(key) headers['x-api-key'] = key;
      const res = await fetch('/api/state', { headers }); const data = await res.json(); if(!data.ok) return false;
      const state = data.state || {};
      // merge server state with local caches (don't clobber local-only records)
      // Students: prefer server copy but keep any local students that the server doesn't know about
  if(Array.isArray(state.students)){
    try{
      const localStudents = read(LS.students) || [];
      const serverStudents = state.students.slice();
      const known = new Set(serverStudents.map(s=>s.id));
      // add any local-only students to server list so they are preserved
      localStudents.forEach(ls => { if(ls && ls.id && !known.has(ls.id)) serverStudents.push(ls); });
      write(LS.students, serverStudents);
    }catch(e){ write(LS.students, state.students); }
  }
  if(Array.isArray(state.attendance)){
    const deleted = read(LS.deleted_att) || [];
    const filtered = state.attendance.filter(a => !deleted.includes(a.id));
    write(LS.attendance, filtered);
  }
      return true;
    }catch(e){ console.warn('fetchState failed',e); return false; }
  }

  // sync unsynced to server
  async function syncLocalToServer(){
    if(!serverOnline) return;
    const students = read(LS.students);
    const attendance = read(LS.attendance);
    const unsyncedAtt = read(LS.unsynced_att) || [];
    if(unsyncedAtt.length===0) return;
    try{
      const payload = { students, attendance: unsyncedAtt };
      const headers = {'content-type':'application/json'}; const key = localStorage.getItem('dtc_sync_key'); if(key) headers['x-api-key'] = key;
      const res = await fetch('/api/sync',{method:'POST',headers,body:JSON.stringify(payload)});
      const j = await res.json(); if(j.ok){
  // clear unsynced
  localStorage.removeItem(LS.unsynced_att);
        appendScanLog('Synced local records to server');
      }
    }catch(e){ console.warn('sync failed',e); }
  }

  // server interactions
  // fingerprint/device code removed — manual check-in and server-backed attendance remain

  async function postAttendanceToServer(rec){
    try{
      const headers = {'content-type':'application/json'}; const key = localStorage.getItem('dtc_sync_key'); if(key) headers['x-api-key'] = key;
      const res = await fetch('/api/attendance',{method:'POST',headers,body:JSON.stringify(rec)});
      const j = await res.json(); return j;
    }catch(e){ return null; }
  }

  // UI and app logic
  function appendScanLog(text){ const log = $('#scan-log'); const p=document.createElement('div'); p.className='muted'; p.style.padding='6px 0'; p.textContent = text; if(log && log.prepend) log.prepend(p); else dbg('[log]', text); }

  // Admin/export/import feature removed — backup of original code is stored in removed/cleanup-20251108-120000/

  // predefined courses (only allowed choices)
  const COURSES = ['Car','Motorcycle'];

  // package definitions per course
  const PACKAGES = {
    Car: [
      { id: 'car_30', days: 30, label: '30 days', price: 20000 },
      { id: 'car_20', days: 20, label: '20 days', price: 14000 },
      { id: 'car_15', days: 15, label: '15 days', price: 11000 },
      { id: 'car_7',  days: 7,  label: '7 days',  price: 6000 },
      { id: 'car_daily', days: 1, label: 'Daily', price: 600 }
    ],
    Motorcycle: [
      { id: 'bike_30', days: 30, label: '30 days', price: 10000 },
      { id: 'bike_20', days: 20, label: '20 days', price: 7000 },
      { id: 'bike_15', days: 15, label: '15 days', price: 5500 },
      { id: 'bike_7',  days: 7,  label: '7 days',  price: 3000 },
      { id: 'bike_daily', days: 1, label: 'Daily', price: 400 }
    ]
  };


  function renderStudents(filter=''){
    const list = read(LS.students);
    const container = $('#student-list'); container.innerHTML = '';
    const datalist = $('#students-datalist'); if(datalist) datalist.innerHTML = '';
    const q = (filter||'').trim().toLowerCase();
    const matches = list.filter(s=>!q || (s.name+s.phone).toLowerCase().includes(q));
    const matchCount = matches.length;
    function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function highlight(text, q){ if(!q) return escapeHtml(text); const idx = text.toLowerCase().indexOf(q); if(idx<0) return escapeHtml(text); return escapeHtml(text.slice(0,idx)) + '<mark>' + escapeHtml(text.slice(idx, idx+q.length)) + '</mark>' + escapeHtml(text.slice(idx+q.length)); }

    // group matches by course (Car, Motorcycle, Uncategorized)
    const groups = {};
    // initialize groups in the desired order
    COURSES.forEach(c=> groups[c] = []);
    groups['Uncategorized'] = [];
    matches.forEach(s=>{
      const key = s.course && COURSES.includes(s.course) ? s.course : 'Uncategorized';
      groups[key].push(s);
    });

    // create a groups wrapper to allow column layout
    const groupsWrap = document.createElement('div'); groupsWrap.className = 'student-groups';
    Object.keys(groups).forEach(groupName=>{
      const items = groups[groupName];
      if(items.length===0) return; // skip empty groups
      const groupWrap = document.createElement('div'); groupWrap.className = 'student-group';
      // make Uncategorized span full width on wide screens
      if(groupName === 'Uncategorized') groupWrap.classList.add('student-group--full'); else groupWrap.classList.add('student-group--col');

      const header = document.createElement('div'); header.className = 'student-group-header';
      const hTitle = document.createElement('div'); hTitle.innerHTML = `<strong>${escapeHtml(groupName)}</strong>`;
      const hCount = document.createElement('div'); hCount.className='muted'; hCount.style.fontSize='13px'; hCount.textContent = items.length + ' student' + (items.length===1?'':'s');
      header.appendChild(hTitle); header.appendChild(hCount);
      groupWrap.appendChild(header);

      const ul = document.createElement('ul'); ul.className='list group-list'; ul.style.marginBottom='12px';
      items.forEach(s=>{
        const li = document.createElement('li');
        // normalize package if it's stored as an id or minimal object
        let pkgHtml = '';
        if(s.package){
            let pkgObj = null;
            // try resolve under current course
            if(typeof s.package === 'string') pkgObj = PACKAGES[s.course]?.find(p=>p.id===s.package);
            else if(s.package && !s.package.price && s.package.id) pkgObj = PACKAGES[s.course]?.find(p=>p.id===s.package.id);
            // if not found, search globally across PACKAGES (handles mismatched course/package combos)
            if(!pkgObj){
              const tryId = (typeof s.package === 'string') ? s.package : (s.package && s.package.id ? s.package.id : null);
              if(tryId){
                Object.keys(PACKAGES).forEach(c=>{
                  if(pkgObj) return;
                  const found = PACKAGES[c].find(p=>p.id===tryId);
                  if(found){ pkgObj = found; if(!s.course) s.course = c; }
                });
              }
            }
            if(pkgObj) { s.package = pkgObj; /* persist normalized package */ const all = read(LS.students).map(x=> x.id===s.id? s : x); write(LS.students, all); }
          if(s.package && s.package.label) pkgHtml = `<div class="muted" style="font-size:13px">Package: ${s.package.label} — NPR ${s.package.price.toLocaleString()}</div>`;
        }
        li.innerHTML = `<div class="stu-info" data-id="${s.id}"><strong>${highlight(s.name, q)}</strong><div class="muted">${highlight(s.phone||'-', q)} • ${escapeHtml(s.course||'-')}</div>${pkgHtml}</div>
          <div style="display:flex;gap:8px"><button class="btn" data-id="${s.id}" data-action="del">Delete</button></div>`;
        ul.appendChild(li);
        if(datalist){ const opt = document.createElement('option'); opt.value = s.name; opt.setAttribute('data-id', s.id); datalist.appendChild(opt); }
      });
      groupWrap.appendChild(ul);
      groupsWrap.appendChild(groupWrap);
    });
    container.appendChild(groupsWrap);
    // attach click listeners directly to each student info block (delegation may miss some targets in some browsers)
    try{
      groupsWrap.querySelectorAll('.stu-info').forEach(el=>{
        el.removeEventListener('click', el._stuClickHandler);
  el._stuClickHandler = function(e){ const sid = el.getAttribute('data-id'); dbg('stu-info clicked', sid); if(sid) renderStudentModal(sid); };
        el.addEventListener('click', el._stuClickHandler);
      });
    }catch(e){ /* ignore if query fails */ }
    // enhance scroll visuals for group lists
    try{ enhanceGroupScroll(); }catch(e){ /* ignore if helper not present yet */ }

    $('#count-students').textContent = list.length;
    const countEl = document.getElementById('student-search-count'); if(countEl) countEl.textContent = q ? (matchCount + ' result' + (matchCount===1?'':'s')) : '';
  }

  // Render suggestions for manual check-in dropdown
  function renderManualSuggestions(query){
    const list = read(LS.students);
    const container = $('#manual-suggestions'); if(!container) return;
    container.innerHTML = '';
    const q = (query||'').trim().toLowerCase();
    const matches = list.filter(s=> !q || (s.name + ' ' + (s.phone||'')).toLowerCase().includes(q)).slice(0,12);
    if(matches.length===0){ container.classList.add('hidden'); manualSelectedId = null; return; }
    matches.forEach((s, idx)=>{
      const li = document.createElement('li'); li.className=''; li.setAttribute('data-id', s.id);
      li.innerHTML = `<div style="display:flex;flex-direction:column"><strong>${s.name}</strong><div class="muted">${s.phone||'-'}</div></div>`;
      li.addEventListener('click', ()=>{
        manualSelectedId = s.id; $('#manual-search').value = s.name + (s.phone?(' — '+s.phone):''); container.classList.add('hidden');
      });
      container.appendChild(li);
    });
    container.classList.remove('hidden');
  }

  function addStudent(data){
    const rawName = (data.name||'').trim();
    if(!rawName) return alert('Name required');
    const students = read(LS.students);
    // normalize and title-case the name for storage/display
    const nameVal = titleCase(rawName);
    // phone: strip non-digits then require exactly 10 digits if provided
    let phoneVal = (data.phone||'').trim();
    let phoneDigits = phoneVal.replace(/\D/g,'');
    if(phoneDigits){
      if(phoneDigits.length !== 10) return alert('Phone number must contain exactly 10 digits (Nepal format).');
      phoneVal = phoneDigits; // store cleaned digits-only phone
      const dup = students.find(x=> (x.phone||'').trim() === phoneVal );
      if(dup) return alert('A student with this phone number already exists. Please use a different phone.');
    }
    // normalize course to Title Case so PACKAGES lookup works even if user typed lowercase
    const courseVal = (data.course||'').trim() ? titleCase(data.course.trim()) : '';
    const s={id:uid('s'),name:nameVal,phone:phoneVal,course:courseVal};
    // attach selected package data if present
    if(data.packageId){
      // try resolve against the provided/normalized course first
      let pkg = null;
      if(courseVal && PACKAGES[courseVal]) pkg = PACKAGES[courseVal].find(p=>p.id===data.packageId);
      // if not found, search globally across PACKAGES (robust when course input/state is inconsistent)
      if(!pkg){
        Object.keys(PACKAGES).forEach(c=>{
          if(pkg) return;
          const found = PACKAGES[c].find(p=>p.id===data.packageId);
          if(found){ pkg = found; if(!s.course) s.course = c; }
        });
      }
      if(pkg) s.package = pkg;
    }
    students.unshift(s); write(LS.students,students); renderStudents(); appendScanLog(`Added student ${s.name}`);
    // optionally sync immediately
    if(serverOnline) syncLocalToServer();
    // enforce allowed courses (after normalization)
    if(s.course && !COURSES.includes(s.course)){
      alert('Please choose a valid course: Car or Motorcycle');
      // remove the student we just added to avoid invalid data
      let cur = read(LS.students) || [];
      cur = cur.filter(x=>x.id !== s.id);
      write(LS.students, cur);
      renderStudents();
      return;
    }
  }

  function deleteStudent(id){ let students=read(LS.students); students=students.filter(s=>s.id!==id); write(LS.students,students); renderStudents(); appendScanLog('Deleted student'); }

  // payments helpers
  function getPaymentsForStudent(studentId){ const all = read(LS.payments) || []; return all.filter(p=>p.studentId===studentId); }
  function getTotalPaid(studentId){
    // sum only actual paid amounts (discounts are tracked separately)
    return getPaymentsForStudent(studentId).reduce((s,p)=>{
      const amt = Number(p.amount||0);
      return s + Math.max(0, amt);
    },0);
  }
  // sum discounts given to a student
  function getTotalDiscounts(studentId){
    return getPaymentsForStudent(studentId).reduce((s,p)=>{
      const d = Number(p.discount||0);
      return s + Math.max(0, d);
    },0);
  }
  // return outstanding amount for a student's package (price - credited). If no package, returns null
  function getOutstanding(studentId){
    const students = read(LS.students) || [];
    const stu = students.find(s=>s.id===studentId);
    if(!stu || !stu.package) return null;
    const price = Number(stu.package.price||0);
    const paid = getTotalPaid(studentId);
    const discounts = getTotalDiscounts(studentId);
    return Math.max(0, price - (paid + discounts));
  }
  // method: 'cash' | 'qr'; discount: numeric
  function addPayment(studentId, amount, note, method='cash', discount=0){
    const all = read(LS.payments) || [];
    // capture student snapshot so name remains available even if student is later deleted
    const students = read(LS.students) || [];
    const stu = studentId ? students.find(s=>s.id===studentId) : null;
    const receipt = getNextReceiptNumber();
    // normalize inputs
    let amt = Number(amount||0);
    let disc = Number(discount||0);
    if(amt < 0) amt = 0;
    if(disc < 0) disc = 0;
    // if student has a package, ensure we don't over-apply discounts/payments beyond package price
    const outstanding = getOutstanding(studentId);
    if(outstanding !== null){
      const totalCredit = amt + disc;
      if(amt > outstanding){
        // too large amount entered; cap amount to outstanding and zero discount
        amt = outstanding;
        disc = 0;
        alert('Payment amount exceeded remaining package balance. Amount has been capped to the remaining due.');
      } else if(totalCredit > outstanding){
        // reduce discount so totalCredit equals outstanding
        const allowedDisc = Math.max(0, outstanding - amt);
        if(allowedDisc < disc){
          disc = allowedDisc;
          alert('Discount reduced so total credit does not exceed remaining package balance.');
        }
      }
    }
    const p = { id: uid('pay'), receiptNumber: receipt, studentId: studentId||null, studentName: stu ? stu.name : null, studentPhone: stu ? stu.phone : null, studentCourse: stu ? stu.course : null, amount: Number(amt), discount: Number(disc), method: method||'cash', note: note||'', time: new Date().toISOString() };
    all.unshift(p); write(LS.payments, all);
    appendScanLog(`Payment recorded: NPR ${Number(p.amount)} (${p.method}) for ${p.studentName || p.studentId} — ${p.receiptNumber}${p.discount?(' • Discount NPR ' + Number(p.discount)):''}`);
    return p;
  }

  // render student details modal: package, days left (based on attendance), payments
  function renderStudentModal(studentId){ const students = read(LS.students); const student = students.find(s=>s.id===studentId); if(!student) return alert('Student not found');
  try{ dbg('renderStudentModal called for', studentId, student); }catch(e){}
    const attendanceAll = read(LS.attendance) || [];
    const daysAttended = attendanceAll.filter(a=>a.studentId===studentId).length;
    let pkgHtml = '<div class="muted">No package selected</div>';
    let daysLeft = null; let price = 0; let pkgId = '';
    if(student.package){
      // if package stored as id/partial, try to resolve from PACKAGES
      let pkgObj = null;
      // try resolve under the student's course first
      if(typeof student.package === 'string') pkgObj = PACKAGES[student.course]?.find(p=>p.id===student.package);
      else if(student.package && !student.package.price && student.package.id) pkgObj = PACKAGES[student.course]?.find(p=>p.id===student.package.id);
      // fallback: search globally across PACKAGES
      if(!pkgObj){
        const tryId = (typeof student.package === 'string') ? student.package : (student.package && student.package.id ? student.package.id : null);
        if(tryId){
          Object.keys(PACKAGES).forEach(c=>{
            if(pkgObj) return;
            const found = PACKAGES[c].find(p=>p.id===tryId);
            if(found){ pkgObj = found; if(!student.course) student.course = c; }
          });
        }
      }
      if(pkgObj){ student.package = pkgObj; // persist normalization
        const all = read(LS.students).map(x=> x.id===studentId? student : x); write(LS.students, all); }
      price = Number(student.package.price||0); daysLeft = Math.max(0, Number(student.package.days||0) - daysAttended); pkgId = student.package.id || '';
      pkgHtml = `<div class="pkg-block"><div class="pkg-badge">${escapeHtml(student.course||'')}</div><div class="pkg-meta"><div class="pkg-title">${escapeHtml(student.package.label)} <span class="muted" style="font-size:13px">(${student.package.days} days)</span></div><div class="pkg-price">NPR ${student.package.price.toLocaleString()}</div><div class="muted">Package ID: <code style="background:transparent;color:var(--muted);font-size:12px">${escapeHtml(pkgId)}</code></div></div></div>`;
    }
  const totalPaid = getTotalPaid(studentId);
  const totalDiscounts = getTotalDiscounts(studentId);
  const paymentLeft = student.package ? Math.max(0, price - (totalPaid + totalDiscounts)) : 0;
    const payments = getPaymentsForStudent(studentId);
    // build modal content
    let html = `<h3>${student.name}</h3><div class="muted">${student.phone || '-'} • ${student.course || '-'}</div><hr/>`;
  html += `<h4>Package</h4>${pkgHtml}`;
    if(student.package){ html += `<div style="margin-top:8px">Days attended: <strong>${daysAttended}</strong> — Days left: <strong>${daysLeft}</strong></div>`; }
  html += `<h4 style="margin-top:12px">Payments</h4><div>Total paid: <strong>NPR ${totalPaid.toLocaleString()}</strong> <span class="muted">(Discounts NPR ${totalDiscounts.toLocaleString()})</span> — Remaining: <strong>NPR ${paymentLeft.toLocaleString()}</strong></div>`;
  html += `<div style="margin-top:10px"><label>Amount (NPR)</label><input id="pay-amount" type="number" min="1" style="width:160px;padding:8px;margin-top:6px;border-radius:6px;background:var(--glass);border:1px solid rgba(255,255,255,0.04)" /></div>`;
  html += `<div style="margin-top:8px"><label>Discount (NPR)</label><input id="pay-discount" type="number" min="0" value="0" style="width:120px;padding:8px;margin-top:6px;border-radius:6px;background:var(--glass);border:1px solid rgba(255,255,255,0.04)" /></div>`;
  html += `<div style="margin-top:10px"><label>Method</label><div style="display:flex;gap:8px;margin-top:6px"><button id="pay-method-cash" class="btn method-btn selected">Cash</button><button id="pay-method-qr" class="btn method-btn">QR</button></div></div>`;
  html += `<div style="margin-top:8px"><label>Note (optional)</label><input id="pay-note" placeholder="e.g., installment 1" style="width:100%;padding:8px;margin-top:6px;border-radius:6px;background:var(--glass);border:1px solid rgba(255,255,255,0.04)" /></div>`;
  html += `<div style="margin-top:10px;display:flex;gap:8px"><button id="pay-record" class="btn primary">Record Payment</button><button id="pay-full" class="btn">Mark Full Paid</button></div>`;
  // quick print actions: record+print and full+print
  html += `<div style="margin-top:8px;display:flex;gap:8px"><button id="pay-record-print" class="btn">Record & Print</button><button id="pay-full-print" class="btn">Mark Full & Print</button></div>`;
  if(payments.length){ html += `<hr/><h4>History</h4><ul class="list">${payments.map(p=>{ const r= p.receiptNumber ? ' — ' + escapeHtml(p.receiptNumber) : ''; return `<li style="display:flex;justify-content:space-between;align-items:center"><div><strong>NPR ${Number(p.amount||0).toLocaleString()}</strong> <span class="muted" style="margin-left:8px">${escapeHtml((p.method||'cash').toUpperCase())}</span><div class="muted">${new Date(p.time).toLocaleString()}${r} • ${p.note||''} ${p.discount?(' • Discount NPR ' + Number(p.discount).toLocaleString()):''}</div></div><div><button class="btn" data-action="pprint" data-id="${p.id}">Print</button> <button class="btn" data-action="pdel" data-id="${p.id}">Delete</button></div></li>` }).join('')}</ul>`; }
  try{ _showModal(html); }catch(e){ try{ dbg('Modal show failed, falling back', e); }catch(_){} showModal(html); }
    // wire modal buttons
    setTimeout(()=>{
      const btn = document.getElementById('pay-record'); if(btn){ btn.addEventListener('click', ()=>{
        const amtEl = document.getElementById('pay-amount'); const noteEl = document.getElementById('pay-note'); const discEl = document.getElementById('pay-discount');
        const methodCash = document.getElementById('pay-method-cash'); const methodQr = document.getElementById('pay-method-qr');
        const amt = amtEl ? Number(amtEl.value||0) : 0; const note = noteEl ? noteEl.value : '';
        const discount = discEl ? Number(discEl.value||0) : 0;
        const method = methodQr && methodQr.classList.contains('selected') ? 'qr' : 'cash';
        if(!amt || amt<=0) return alert('Enter a valid amount');
        addPayment(studentId, amt, note, method, discount);
        renderStudents(); renderCounts(); renderStudentModal(studentId);
      }); }
      const btnRecordPrint = document.getElementById('pay-record-print'); if(btnRecordPrint){ btnRecordPrint.addEventListener('click', ()=>{
        const amtEl = document.getElementById('pay-amount'); const noteEl = document.getElementById('pay-note'); const discEl = document.getElementById('pay-discount');
        const methodCash = document.getElementById('pay-method-cash'); const methodQr = document.getElementById('pay-method-qr');
        const amt = amtEl ? Number(amtEl.value||0) : 0; const note = noteEl ? noteEl.value : '';
        const discount = discEl ? Number(discEl.value||0) : 0;
        const method = methodQr && methodQr.classList.contains('selected') ? 'qr' : 'cash';
        if(!amt || amt<=0) return alert('Enter a valid amount');
        addPayment(studentId, amt, note, method, discount);
        const last = (read(LS.payments) || [])[0]; if(last) printPayment(last.id);
        renderStudents(); renderCounts(); renderStudentModal(studentId);
      }); }
      const btn2 = document.getElementById('pay-full'); if(btn2){ btn2.addEventListener('click', ()=>{
        if(!student.package) return alert('No package to mark paid');
        const need = Math.max(0, Number(student.package.price||0) - getTotalPaid(studentId)); if(need<=0) return alert('Already fully paid');
        if(!confirm(`Mark full payment of NPR ${need.toLocaleString()} as paid?`)) return;
        const method = (document.getElementById('pay-method-qr') && document.getElementById('pay-method-qr').classList.contains('selected')) ? 'qr' : 'cash';
        addPayment(studentId, need, 'Full payment', method, 0);
        renderStudents(); renderCounts(); renderStudentModal(studentId);
      }); }
      const btnFullPrint = document.getElementById('pay-full-print'); if(btnFullPrint){ btnFullPrint.addEventListener('click', ()=>{
        if(!student.package) return alert('No package to mark paid');
        const need = Math.max(0, Number(student.package.price||0) - getTotalPaid(studentId)); if(need<=0) return alert('Already fully paid');
        if(!confirm(`Mark full payment of NPR ${need.toLocaleString()} as paid?`)) return;
        const method = (document.getElementById('pay-method-qr') && document.getElementById('pay-method-qr').classList.contains('selected')) ? 'qr' : 'cash';
        addPayment(studentId, need, 'Full payment', method, 0);
        const last = (read(LS.payments) || [])[0]; if(last) printPayment(last.id);
        renderStudents(); renderCounts(); renderStudentModal(studentId);
      }); }
      // method button toggles
      const mCash = document.getElementById('pay-method-cash'); const mQr = document.getElementById('pay-method-qr');
      if(mCash && mQr){ mCash.addEventListener('click', ()=>{ mCash.classList.add('selected'); mQr.classList.remove('selected'); }); mQr.addEventListener('click', ()=>{ mQr.classList.add('selected'); mCash.classList.remove('selected'); }); }
      // attach delete handlers for payments listed in modal
      setTimeout(()=>{
        try{
          document.querySelectorAll('#modal-body button[data-action="pdel"]').forEach(b=>{
            b.removeEventListener('click', b._pdelHandler);
            b._pdelHandler = function(){ const pid = b.getAttribute('data-id'); if(pid) deletePayment(pid, studentId); };
            b.addEventListener('click', b._pdelHandler);
          });
          // attach print handlers for payments in modal
          document.querySelectorAll('#modal-body button[data-action="pprint"]').forEach(b=>{
            b.removeEventListener('click', b._pprintHandler);
            b._pprintHandler = function(){ const pid = b.getAttribute('data-id'); if(pid) printPayment(pid); };
            b.addEventListener('click', b._pprintHandler);
          });
        }catch(e){ /* ignore */ }
      },60);
    },40);
  }

  function recordAttendanceLocal(studentId, fingerprintId, name){
    // prevent duplicate attendance for same phone today
    const students = read(LS.students);
    const student = studentId ? students.find(s=>s.id===studentId) : null;
    const phone = student ? (student.phone || null) : null;
    if(phone){
      const today = new Date().toISOString().slice(0,10);
      const attendanceAll = read(LS.attendance) || [];
      const dup = attendanceAll.find(a=> (a.time||'').slice(0,10)===today && ((a.studentId && a.studentId===studentId) || (a.phone && a.phone===phone)) );
      if(dup){ alert('Attendance already recorded for phone ' + phone + ' today. Only one check-in allowed per phone.'); return; }
    }

  const attendance = read(LS.attendance); const rec = { id: uid('a'), studentId: studentId||null, name: name||null, phone: phone||null, time: new Date().toISOString() };
    attendance.unshift(rec); write(LS.attendance,attendance); appendScanLog(`${name||studentId} checked in (local)`);
    // if server available attempt to post
    if(serverOnline){ postAttendanceToServer(rec).then(r=>{ if(r && r.ok) appendScanLog('Recorded on server'); else { // store unsynced
        const uns = read(LS.unsynced_att) || []; uns.push(rec); write(LS.unsynced_att,uns); appendScanLog('Queued for sync'); } }); }
    else { const uns = read(LS.unsynced_att) || []; uns.push(rec); write(LS.unsynced_att,uns); appendScanLog('Queued for sync'); }
    renderAttendance();
  }

  function renderAttendance(){
    const attendanceAll = read(LS.attendance) || [];
    // support single-date filtering via #attendance-date; default to today when no input is set
    const aDateEl = document.getElementById('attendance-date');
    const aDate = aDateEl ? (aDateEl.value || '') : '';
    let attendance = [];
    if(aDate){
      attendance = attendanceAll.filter(a => (a.time||'').slice(0,10) === aDate);
    } else {
      const today = new Date().toISOString().slice(0,10);
      attendance = attendanceAll.filter(a=>a.time.slice(0,10)===today);
    }
    const list = $('#attendance-list'); list.innerHTML='';
    const students = read(LS.students) || [];
    attendance.forEach(a=>{
      const li=document.createElement('li');
      // find student if available
      const stu = a.studentId ? students.find(s=>s.id===a.studentId) : null;
      let extraHtml = '';
      let cls = '';
      if(stu && stu.package){
        const daysAtt = attendanceAll.filter(x=>x.studentId===stu.id).length;
        const daysLeft = Math.max(0, Number(stu.package.days||0) - daysAtt);
        const dueAmt = Math.max(0, Number(stu.package.price||0) - getTotalPaid(stu.id));
        const daysText = `${daysLeft} day${daysLeft===1?'':'s'} left`;
        // show an explicit urgent badge when exactly 3 days are left; otherwise show normal text
        if(daysLeft === 3){
          extraHtml = `<div class="muted">${escapeHtml(stu.course||'-')} • <span class="badge badge-urgent" aria-label="${escapeHtml(daysText)}">🔔 ${escapeHtml(daysText)}</span> • NPR ${Number(dueAmt).toLocaleString()} due</div>`;
          cls = 'due-3';
        } else {
          extraHtml = `<div class="muted">${escapeHtml(stu.course||'-')} • ${escapeHtml(daysText)} • NPR ${Number(dueAmt).toLocaleString()} due</div>`;
        }
      }
      li.setAttribute('data-student-id', a.studentId || '');
      li.className = cls;
      li.innerHTML = `<div><strong>${escapeHtml(a.name||a.studentId||'Unknown')}</strong><div class="muted">${a.phone? a.phone + ' • ' : ''}${new Date(a.time).toLocaleString()}</div>${extraHtml}</div><div><button class="btn" data-id="${a.id}" data-action="adel">Delete</button></div>`;
      list.appendChild(li);
    });
    $('#count-attendance').textContent = attendance.length;
  }

  // delete attendance record locally (and attempt server delete)
  function deleteAttendanceLocal(attId){
    if(!confirm('Delete this attendance record?')) return;
    let attendance = read(LS.attendance) || [];
    attendance = attendance.filter(a=>a.id!==attId);
    write(LS.attendance, attendance);
    appendScanLog('Attendance deleted locally');
    // mark as locally deleted so server state won't re-introduce it on next fetch
    try{
      const deleted = read(LS.deleted_att) || [];
      if(!deleted.includes(attId)) { deleted.push(attId); write(LS.deleted_att, deleted); }
    }catch(e){ /* ignore */ }
    // try server delete and clear local tombstone if successful
    if(serverOnline){
      (async ()=>{
        try{
          const headers = {'content-type':'application/json'}; const key = localStorage.getItem('dtc_sync_key'); if(key) headers['x-api-key'] = key;
          const res = await fetch('/api/attendance/delete',{method:'POST',headers,body:JSON.stringify({id:attId})});
          const j = await res.json();
          if(j && j.ok){
            appendScanLog('Deleted on server');
            // remove tombstone
            try{ const deleted = read(LS.deleted_att) || []; const nd = deleted.filter(x=>x!==attId); write(LS.deleted_att, nd); }catch(e){}
          } else {
            appendScanLog('Server delete failed');
            if(res && res.status === 401) alert('Server rejected the delete request (unauthorized). Ensure the SYNC_KEY is set correctly.');
          }
        }catch(e){ appendScanLog('Server delete failed'); }
      })();
    }
    renderAttendance();
  }

  // delete a payment entry
  function deletePayment(paymentId, studentId){
    if(!confirm('Delete this payment?')) return;
    const all = read(LS.payments) || [];
    const found = all.find(p=>p.id===paymentId);
    if(!found) return alert('Payment not found');
    const remaining = all.filter(p=>p.id!==paymentId);
    write(LS.payments, remaining);
    appendScanLog(`Payment deleted: ${paymentId}`);
    // refresh UI
    renderStudents(); renderTransactions(); renderCounts();
    // if modal for this student is open, re-open it to refresh history
    if(studentId){ setTimeout(()=>{ try{ renderStudentModal(studentId); }catch(e){} },80); }
  }

  // product/pos transactions removed — product-based transactions are no longer tracked in this build

  // fingerprint/device simulation removed — manual check-in flow is used instead

  function showModal(html){ $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal(){ $('#modal').classList.add('hidden'); $('#modal-body').innerHTML=''; }

  // stronger show/hide helpers with defensive styling and debug logs
  function _showModal(html){
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    if(!modal || !body){ console.warn('Modal or modal-body not found'); return; }
    body.innerHTML = html;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden','false');
    // bring to front
    modal.style.zIndex = 100000;
    dbg('Modal opened');
  }
  function _closeModal(){ const modal = document.getElementById('modal'); const body = document.getElementById('modal-body'); if(modal) modal.classList.add('hidden'); if(modal) modal.style.display='none'; if(body) body.innerHTML=''; dbg('Modal closed'); }

  // show a small modal UI to let staff paste or clear the SYNC_KEY without using DevTools
  function showSyncKeyModal(){
    const cur = localStorage.getItem('dtc_sync_key') || '';
    const masked = cur ? (cur.slice(0,6) + '...' + cur.slice(-4)) : '';
    const html = `
      <h3>Server Sync Key</h3>
      <div class="muted">Enter the shared SYNC_KEY provided for this pilot. This will be stored in the browser's localStorage on this device only.</div>
      <div style="margin-top:12px"><label style="display:block;margin-bottom:6px">Current (masked): <code style="background:transparent;color:var(--muted)">${masked || 'not set'}</code></label><input id="sync-key-input" type="text" placeholder="Paste SYNC_KEY here" value="${cur}" style="width:100%;padding:8px;border-radius:6px;border:1px solid rgba(0,0,0,0.1);" /></div>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button id="sync-key-clear" class="btn ghost">Clear</button>
        <button id="sync-key-test" class="btn">Test</button>
        <button id="sync-key-save" class="btn primary">Save</button>
      </div>
    `;
    try{ _showModal(html); }catch(e){ showModal(html); }
    // wire buttons after modal is in DOM
    setTimeout(()=>{
      const inp = document.getElementById('sync-key-input'); const btnSave = document.getElementById('sync-key-save'); const btnClear = document.getElementById('sync-key-clear'); const btnTest = document.getElementById('sync-key-test');
      if(btnSave){ btnSave.addEventListener('click', async ()=>{
        const v = inp ? (inp.value || '').trim() : '';
        if(!v) return alert('Please enter a SYNC_KEY to save or click Clear to remove it.');
        localStorage.setItem('dtc_sync_key', v);
        appendScanLog('SYNC_KEY saved to this device');
        await pingServer();
        renderStudents(); renderAttendance(); renderTransactions();
        _closeModal();
      }); }
      if(btnClear){ btnClear.addEventListener('click', async ()=>{
        if(!confirm('Clear the locally stored SYNC_KEY on this device?')) return;
        localStorage.removeItem('dtc_sync_key');
        appendScanLog('SYNC_KEY cleared from this device');
        await pingServer();
        _closeModal();
      }); }
      if(btnTest){ btnTest.addEventListener('click', async ()=>{
        const v = inp ? (inp.value||'').trim() : '';
        if(!v) return alert('Enter a key to test');
        // temporarily set header for test request
        try{
          const res = await fetch('/api/ping', { headers: { 'x-api-key': v } });
          const j = await res.json(); if(j && j.ok){ alert('Server accepted the key (ok)'); appendScanLog('SYNC_KEY test: accepted'); await pingServer(); } else { alert('Server did not accept the key'); appendScanLog('SYNC_KEY test: rejected'); }
        }catch(e){ alert('Network/test failed: ' + (e.message||e)); appendScanLog('SYNC_KEY test: network failed'); }
      }); }
    },60);
  }

  // product UI, cart and checkout removed — this app build focuses on attendance and payments only

  // print a payment receipt by id (opens a new window and triggers print)
  function printPayment(paymentId){
    const pays = read(LS.payments) || [];
    const p = pays.find(x=>x.id===paymentId);
    if(!p) return alert('Payment not found');
    const students = read(LS.students) || [];
    // prefer stored snapshot, fallback to live student record
    const stuLive = students.find(s=>s.id===p.studentId) || {};
    const name = p.studentName || stuLive.name || (p.studentId || 'Unknown');
    const phone = p.studentPhone || stuLive.phone || '-';
    const course = p.studentCourse || stuLive.course || '-';
  const amt = Number(p.amount||0); const disc = Number(p.discount||0); const credited = amt + disc;
  const win = window.open('', '_blank', 'width=520,height=640');
    if(!win) { alert('Unable to open print window (popup blocked)'); return; }
  const html = `<!doctype html><html><head><title>Receipt ${p.receiptNumber||p.id}</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:20px;color:#071018}h2{margin:0 0 8px} .muted{color:#666;font-size:12px} .line{margin:8px 0}</style></head><body><h2>Driving Training Center</h2><div class="muted">Receipt — ${new Date(p.time).toLocaleString()}</div><div class="muted">Receipt No: <strong>${escapeHtml(p.receiptNumber||p.id)}</strong></div><hr/><div class="line"><strong>Student:</strong> ${escapeHtml(name)}</div><div class="line"><strong>Phone:</strong> ${escapeHtml(phone)}</div><div class="line"><strong>Course:</strong> ${escapeHtml(course)}</div><div class="line"><strong>Method:</strong> ${escapeHtml((p.method||'cash').toUpperCase())}</div><div class="line"><strong>Actual amount:</strong> NPR ${Number(credited).toLocaleString()}</div><div class="line"><strong>Discount:</strong> NPR ${Number(disc).toLocaleString()}</div><div class="line"><strong>Total paid:</strong> NPR ${Number(amt).toLocaleString()}</div><div class="line"><strong>Note:</strong> ${escapeHtml(p.note||'')}</div><hr/><div style="margin-top:12px"><button id="doPrint">Print</button></div></body></html>`;
    win.document.open(); win.document.write(html); win.document.close();
    setTimeout(()=>{ try{ const btn = win.document.getElementById('doPrint'); if(btn){ btn.addEventListener('click', ()=>{ win.print(); }); } else { win.print(); } }catch(e){} },120);
  }

  

  // render payment-only timeline (POS/product transactions removed)
  function renderTransactions(){
    const pays = read(LS.payments) || [];
    const students = read(LS.students) || [];
    // optional single-date filter from Transactions control (#tx-date)
    const txDateEl = document.getElementById('tx-date'); const txDate = txDateEl ? (txDateEl.value || '') : '';
    let list = pays.slice();
    if(txDate) list = list.filter(p=> (p.time||'').slice(0,10) === txDate);
    list.sort((a,b)=> new Date(b.time) - new Date(a.time));
    const container = $('#transaction-list'); container.innerHTML = '';
    list.forEach(p=>{
      const li = document.createElement('li');
      const stu = students.find(s=>s.id===p.studentId) || {};
      const amt = Number(p.amount||0);
      const name = p.studentName || stu.name || p.studentId || 'Unknown';
      const course = p.studentCourse || stu.course || '-';
      const r = p.receiptNumber ? ' • ' + escapeHtml(p.receiptNumber) : '';
        li.innerHTML = `<div><strong>PAY${r}</strong><div class="muted">${escapeHtml(name)} • ${escapeHtml(course)} • ${new Date(p.time).toLocaleString()}</div></div><div>NPR ${Number(amt).toLocaleString()} <div class="muted" style="font-size:12px">${escapeHtml((p.method||'cash').toUpperCase())}${p.discount?(' • Discount NPR ' + Number(p.discount).toLocaleString()):''}</div><div style="margin-top:6px"><button class="btn" data-action="pprint" data-id="${escapeHtml(p.id)}">Print</button> <button class="btn" data-action="pdel" data-id="${escapeHtml(p.id)}">Delete</button></div></div>`;
      container.appendChild(li);
    });
    const _ct = $('#count-transactions'); if(_ct) _ct.textContent = list.length;
  }

  function renderCounts(){ renderAttendance(); renderTransactions(); renderDashboardWidgets(); }
  // Render dashboard extras: due soon, discounts, payments by course
  function renderDashboardWidgets(){
    try{
      const dueEl = $('#due-soon-list'); const discEl = $('#discounts-list'); const txCarEl = $('#tx-car'); const txBikeEl = $('#tx-bike');
      if(!dueEl && !discEl && !txCarEl && !txBikeEl) return;
      const students = read(LS.students) || [];
      const attendance = read(LS.attendance) || [];
      const payments = read(LS.payments) || [];
      // due soon: students with package, paymentLeft>0 and daysLeft<=3 (include 3-day warning)
      const due = [];
      students.forEach(s=>{
        if(!s.package) return;
        const daysAtt = attendance.filter(a=>a.studentId===s.id).length;
        const daysLeft = Math.max(0, Number(s.package.days||0) - daysAtt);
        const price = Number(s.package.price||0);
        const paid = getTotalPaid(s.id);
        const left = Math.max(0, price - paid);
        if(left>0 && daysLeft<=3){ due.push({id:s.id,name:s.name,course:s.course,daysLeft,left}); }
      });
      due.sort((a,b)=>a.daysLeft - b.daysLeft || b.left - a.left);
  if(dueEl){ dueEl.innerHTML = due.slice(0,10).map(d=>{
      const badgeHtml = d.daysLeft === 3 ? `<span class="badge badge-urgent">🔔 ${d.daysLeft} day${d.daysLeft===1?'':'s'} left</span>` : `${d.daysLeft} day${d.daysLeft===1?'':'s'} left`;
      return `<li data-id="${d.id}"><div><strong>${escapeHtml(d.name)}</strong><div class="muted">${escapeHtml(d.course||'-')} • ${badgeHtml} • NPR ${Number(d.left).toLocaleString()} due</div></div></li>`;
    }).join('') || '<li class="muted">No due items</li>' }

    // discounts: recent payments with discount>0 (support optional single-date filter)
    const discDate = document.getElementById('discounts-date') ? document.getElementById('discounts-date').value || '' : '';
    const discPays = payments.filter(p=>Number(p.discount||0) > 0 && (discDate ? ((p.time||'').slice(0,10) === discDate) : true)).sort((a,b)=> new Date(b.time) - new Date(a.time));
  if(discEl){ discEl.innerHTML = discPays.slice(0,10).map(p=>{ const stu = students.find(s=>s.id===p.studentId) || {}; const sid = p.studentId || ''; const name = p.studentName || stu.name || p.studentId || 'Unknown'; const course = p.studentCourse || stu.course || '-'; return `<li data-id="${sid}"><div><strong>${escapeHtml(name)}</strong><div class="muted">${escapeHtml(course)} • NPR ${Number(p.discount).toLocaleString()} • ${new Date(p.time).toLocaleString()}</div></div><div><button class="btn" data-action="pdel" data-id="${p.id}">Delete</button></div></li>`; }).join('') || '<li class="muted">No discounts</li>' }

    // payments by course (sum effective amounts) — allow filtering by single date
    const payDate = document.getElementById('payments-date') ? document.getElementById('payments-date').value || '' : '';
    const byCourse = { Car:0, Motorcycle:0 };
    payments.forEach(p=>{
  const stu = students.find(s=>s.id===p.studentId) || {}; const course = stu.course || 'Uncategorized'; const amt = Math.max(0, Number(p.amount||0) + Number(p.discount||0));
    if(payDate && ((p.time||'').slice(0,10) !== payDate)) return;
    if(course === 'Car') byCourse.Car += amt; else if(course === 'Motorcycle') byCourse.Motorcycle += amt;
    });
      if(txCarEl) txCarEl.textContent = 'NPR ' + Number(byCourse.Car).toLocaleString();
      if(txBikeEl) txBikeEl.textContent = 'NPR ' + Number(byCourse.Motorcycle).toLocaleString();
    }catch(e){ console.warn('renderDashboardWidgets failed', e); }
  }

  function attach(){
    // navigation
    $$('.sidebar a').forEach(a=>a.addEventListener('click', async ev=>{ ev.preventDefault(); const id = a.getAttribute('href').slice(1);
      // Admin panel removed — no gating required
      showPanel(id);
    }));
  // top actions
  $('#btn-add-student').addEventListener('click',()=>{ showPanel('students'); $('#stu-name').focus(); });
    const syncBtn = document.getElementById('btn-sync-key'); if(syncBtn){ syncBtn.addEventListener('click', ()=>{ showSyncKeyModal(); }); }

    // student form
  $('#student-form').addEventListener('submit',ev=>{
      ev.preventDefault();
      const rawCourse = ($('#stu-course').value||'').trim();
      const courseVal = rawCourse ? titleCase(rawCourse) : '';
      const pkgSel = document.getElementById('stu-package-select');
      let pkgId = pkgSel ? (pkgSel.value || null) : null;
      // if course selected but no package explicitly chosen, default to first package for that course
      if(!pkgId && courseVal && PACKAGES[courseVal] && PACKAGES[courseVal].length>0){ pkgId = PACKAGES[courseVal][0].id; const hidden = document.getElementById('stu-package-select'); if(hidden) hidden.value = pkgId; }
  // DEBUG: log what is being submitted so we can verify package selection (gated)
  try{ dbg('[debug] addStudent submit', { name: (document.getElementById('stu-name')||{}).value || '', phone: (document.getElementById('stu-phone')||{}).value || '', course: courseVal, packageId: pkgId, pkgSelectValue: pkgSel?pkgSel.value:null }); }catch(e){}
      addStudent({name:$('#stu-name').value,phone:$('#stu-phone').value,course:courseVal, packageId: pkgId});
      $('#student-form').reset(); if(packageContainer) packageContainer.style.display='none';
  });
    $('#stu-clear').addEventListener('click',()=>document.getElementById('student-form').reset());

    // course suggestions for Add Student
    const courseInput = document.getElementById('stu-course');
    const courseListEl = document.getElementById('stu-course-suggestions');
    const packageContainer = document.getElementById('stu-packages');
    function renderPackageOptions(course){
      if(!packageContainer) return;
      packageContainer.innerHTML = '';
      if(!course || !PACKAGES[course]){ packageContainer.style.display = 'none'; return; }
      const pkgs = PACKAGES[course];
      // create a native <select> for package choices for reliability across browsers
      const label = document.createElement('div'); label.style.fontWeight='600'; label.style.marginBottom='6px'; label.textContent = 'Choose package';
      // reuse existing select if present (avoid duplicate IDs), otherwise create one
      let select = document.getElementById('stu-package-select');
      const sumEl = document.getElementById('stu-package-summary');
      if(!select){
        select = document.createElement('select');
        select.id = 'stu-package-select'; select.name = 'packageId';
        packageContainer.appendChild(select);
      }
      // clear existing options then populate
      select.innerHTML = '';
      pkgs.forEach((p, idx)=>{ const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${p.label} — NPR ${p.price.toLocaleString()} (${p.days}d)`; select.appendChild(opt); });
      // set default
      select.value = pkgs[0].id;
      // ensure select is wrapped in a styled container for better visuals and an inline summary
      (function ensureWrap(){
        let wrap = select.parentElement && select.parentElement.classList && select.parentElement.classList.contains('pkg-select-wrap') ? select.parentElement : null;
        if(!wrap){
          wrap = document.createElement('div'); wrap.className = 'pkg-select-wrap';
          // insert wrap before select and move select inside
          select.parentNode.insertBefore(wrap, select);
          wrap.appendChild(select);
          // move summary inside wrap if exists
          if(sumEl) wrap.appendChild(sumEl);
        }
        // create an inline summary element if not present
        if(!wrap.querySelector('.pkg-inline-summary')){
          const inl = document.createElement('div'); inl.className = 'pkg-inline-summary'; inl.style.marginLeft = '12px'; inl.style.whiteSpace = 'nowrap'; wrap.appendChild(inl);
        }
      })();
      const wrap = select.parentElement;
      const inline = wrap.querySelector('.pkg-inline-summary');
      // update summary area when changed
      const updateSummary = ()=>{
        const p = pkgs.find(x=>x.id===select.value) || pkgs[0];
        const html = `<strong style="color:var(--accent)">${p.label}</strong> — <span style="font-weight:700">NPR ${p.price.toLocaleString()}</span> <span class="muted" style="margin-left:8px;font-size:13px">(${p.days} day${p.days>1?'s':''})</span>`;
        if(sumEl) sumEl.innerHTML = html;
        if(inline) inline.innerHTML = `<span class="pkg-days">${p.days}d</span> <span class="muted" style="margin-left:8px">NPR ${p.price.toLocaleString()}</span>`;
      };
      updateSummary();
      select.removeEventListener('change', select._pkgChangeHandler || (()=>{}));
      select._pkgChangeHandler = updateSummary;
      select.addEventListener('change', select._pkgChangeHandler);
      packageContainer.style.display='block';
      packageContainer.style.display='block';
    }
    function renderCourseSuggestions(q){ if(!courseListEl || !courseInput) return; const val=(q||'').trim().toLowerCase(); courseListEl.innerHTML=''; const matches = COURSES.filter(c=>!val||c.toLowerCase().includes(val)); if(matches.length===0){ courseListEl.classList.add('hidden'); return; } matches.slice(0,8).forEach(c=>{ const li=document.createElement('li'); li.setAttribute('role','option'); li.textContent=c; li.addEventListener('click', ()=>{ courseInput.value = c; courseListEl.classList.add('hidden'); courseInput.focus(); }); courseListEl.appendChild(li); }); courseListEl.classList.remove('hidden'); }
  if(courseInput){ courseInput.addEventListener('input', debounce(ev=>{ renderCourseSuggestions(ev.target.value); renderPackageOptions(ev.target.value); },150)); courseInput.addEventListener('focus', ev=>{ renderCourseSuggestions(courseInput.value); renderPackageOptions(courseInput.value); }); courseInput.addEventListener('blur', ()=>{ setTimeout(()=>{ if(courseListEl) courseListEl.classList.add('hidden'); },150); });
      // keyboard navigation
      courseInput.addEventListener('keydown', ev=>{
        if(!courseListEl) return; const items = Array.from(courseListEl.querySelectorAll('li')); if(items.length===0) return; const active = courseListEl.querySelector('li.active'); let idx = active ? items.indexOf(active) : -1;
        if(ev.key==='ArrowDown'){ ev.preventDefault(); if(idx < items.length-1){ if(active) active.classList.remove('active'); idx++; items[idx].classList.add('active'); items[idx].scrollIntoView({block:'nearest'}); } }
        else if(ev.key==='ArrowUp'){ ev.preventDefault(); if(idx>0){ if(active) active.classList.remove('active'); idx--; items[idx].classList.add('active'); items[idx].scrollIntoView({block:'nearest'}); } }
        else if(ev.key==='Enter'){ if(active){ ev.preventDefault(); const txt = active.textContent; courseInput.value = txt; courseListEl.classList.add('hidden'); courseInput.blur(); renderPackageOptions(txt); } }
      }); }

    // search (debounced) and student list actions
    const searchInput = $('#search-student'); if(searchInput) searchInput.addEventListener('input', debounce(ev=>renderStudents(ev.target.value),220));
  // improved search button and clear
  const searchBtn = $('#search-student-btn'); const clearBtn = $('#search-student-clear');
  if(searchBtn){ searchBtn.addEventListener('click', ()=>{ const v = searchInput ? searchInput.value.trim() : ''; renderStudents(v); if(searchInput) searchInput.focus(); }); }
  if(clearBtn){ clearBtn.addEventListener('click', ()=>{ if(searchInput) searchInput.value=''; renderStudents(''); if(searchInput) searchInput.focus(); const countEl = document.getElementById('student-search-count'); if(countEl) countEl.textContent=''; }); }
  if(searchInput){ searchInput.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); const v = searchInput.value.trim(); renderStudents(v); } }) }
    $('#student-list').addEventListener('click',ev=>{
      const btn = ev.target.closest('button'); if(btn){ const id = btn.getAttribute('data-id'); const action = btn.getAttribute('data-action'); if(action==='del') deleteStudent(id); return; }
      // clicking on student info block opens detail modal
      const infoEl = ev.target.closest('.stu-info'); if(infoEl){ const sid = infoEl.getAttribute('data-id'); if(sid) renderStudentModal(sid); }
    });

    // transaction list delete delegation (payments only in this build)
    const _txList = $('#transaction-list'); if(_txList){ _txList.addEventListener('click', ev=>{
      const btn = ev.target.closest('button'); if(!btn) return; const action = btn.getAttribute('data-action'); const id = btn.getAttribute('data-id');
  if(!action || !id) return;
  // only payment actions are supported now
  if(action === 'pdel') deletePayment(id);
  else if(action === 'pprint') printPayment(id);
    }); }
    // dashboard widgets click handlers: open student modal when clicking a row
    const _due = $('#due-soon-list'); if(_due){ _due.addEventListener('click', ev=>{ const li = ev.target.closest('li[data-id]'); if(!li) return; const id = li.getAttribute('data-id'); if(id) renderStudentModal(id); }); }
    const _disc = $('#discounts-list'); if(_disc){ _disc.addEventListener('click', ev=>{
      const btn = ev.target.closest('button'); if(btn){ const action = btn.getAttribute('data-action'); const id = btn.getAttribute('data-id'); if(action === 'pdel' && id){ deletePayment(id); return; } }
      const li = ev.target.closest('li[data-id]'); if(!li) return; const sid = li.getAttribute('data-id'); if(sid) renderStudentModal(sid);
    }); }

  // date-range controls: apply/clear handlers
  const discountsApply = document.getElementById('discounts-apply'); const discountsClear = document.getElementById('discounts-clear');
  if(discountsApply) discountsApply.addEventListener('click', ()=>{ renderDashboardWidgets(); closeAllPops(); });
  if(discountsClear) discountsClear.addEventListener('click', ()=>{ const d=document.getElementById('discounts-date'); if(d) d.value=''; renderDashboardWidgets(); closeAllPops(); });
  // live update when date changed
  const discountsDateEl = document.getElementById('discounts-date'); if(discountsDateEl) discountsDateEl.addEventListener('change', ()=>{ renderDashboardWidgets(); });

  const paymentsApply = document.getElementById('payments-apply'); const paymentsClear = document.getElementById('payments-clear');
  if(paymentsApply) paymentsApply.addEventListener('click', ()=>{ renderDashboardWidgets(); closeAllPops(); });
  if(paymentsClear) paymentsClear.addEventListener('click', ()=>{ const d=document.getElementById('payments-date'); if(d) d.value=''; renderDashboardWidgets(); closeAllPops(); });
  // live update when date changed
  const paymentsDateEl = document.getElementById('payments-date'); if(paymentsDateEl) paymentsDateEl.addEventListener('change', ()=>{ renderDashboardWidgets(); });

  const attApply = document.getElementById('attendance-apply'); const attClear = document.getElementById('attendance-clear');
  if(attApply) attApply.addEventListener('click', ()=>{ renderAttendance(); $('#count-attendance').textContent = (document.getElementById('attendance-list')||{children:[]}).children.length; closeAllPops(); });
  if(attClear) attClear.addEventListener('click', ()=>{ const d=document.getElementById('attendance-date'); if(d) d.value=''; renderAttendance(); closeAllPops(); });
  // live update when attendance date changed
  const attendanceDateEl = document.getElementById('attendance-date'); if(attendanceDateEl) attendanceDateEl.addEventListener('change', ()=>{ renderAttendance(); $('#count-attendance').textContent = (document.getElementById('attendance-list')||{children:[]}).children.length; });

  const txApply = document.getElementById('tx-apply'); const txClear = document.getElementById('tx-clear');
  if(txApply) txApply.addEventListener('click', ()=>{ renderTransactions(); closeAllPops(); });
  if(txClear) txClear.addEventListener('click', ()=>{ const d=document.getElementById('tx-date'); if(d) d.value=''; renderTransactions(); closeAllPops(); });
  // live update when tx date changed
  const txDateEl = document.getElementById('tx-date'); if(txDateEl) txDateEl.addEventListener('change', ()=>{ renderTransactions(); });

    // calendar popover toggles: open/close popovers on icon click and close when clicking outside
    function closeAllPops(){ document.querySelectorAll('.date-popover').forEach(p=>p.classList.add('hidden')); document.querySelectorAll('.date-toggle').forEach(b=>b.setAttribute('aria-expanded','false')); }
    document.querySelectorAll('.date-toggle').forEach(btn=>{
      btn.addEventListener('click', ev=>{
        ev.stopPropagation(); const popId = btn.getAttribute('data-pop'); if(!popId) return; const pop = document.getElementById(popId); if(!pop) return;
        const isOpen = !pop.classList.contains('hidden'); closeAllPops(); if(!isOpen){ pop.classList.remove('hidden'); btn.setAttribute('aria-expanded','true'); }
      });
    });
    // close popovers when clicking outside
    document.addEventListener('click', ev=>{
      const anyOpen = Array.from(document.querySelectorAll('.date-popover')).some(p=>!p.classList.contains('hidden'));
      if(!anyOpen) return;
      // if click is inside an opened popover or on a toggle button, ignore
      const insidePop = ev.target.closest('.date-popover'); const onToggle = ev.target.closest('.date-toggle'); if(insidePop || onToggle) return;
      closeAllPops();
    });

    // modal
  $('#modal-close').addEventListener('click',_closeModal); $('#modal').addEventListener('click',ev=>{ if(ev.target===$('#modal')) _closeModal(); });

    // manual check-in (custom searchable dropdown)
    const manualInput = $('#manual-search'); const suggestions = $('#manual-suggestions');
    if(manualInput){
      manualInput.addEventListener('input', debounce(ev=>{ renderManualSuggestions(ev.target.value); },220));
      // keyboard navigation
      manualInput.addEventListener('keydown', ev=>{
        if(!suggestions) return;
        const items = Array.from(suggestions.querySelectorAll('li'));
        if(items.length===0) return;
        const active = suggestions.querySelector('li.active');
        let idx = active ? items.indexOf(active) : -1;
        if(ev.key==='ArrowDown'){ ev.preventDefault(); if(idx < items.length-1){ if(active) active.classList.remove('active'); idx++; items[idx].classList.add('active'); items[idx].scrollIntoView({block:'nearest'}); } }
        else if(ev.key==='ArrowUp'){ ev.preventDefault(); if(idx>0){ if(active) active.classList.remove('active'); idx--; items[idx].classList.add('active'); items[idx].scrollIntoView({block:'nearest'}); } }
        else if(ev.key==='Enter'){ ev.preventDefault(); if(active){ const id = active.getAttribute('data-id'); const s = read(LS.students).find(x=>x.id===id); if(s){ manualSelectedId = s.id; manualInput.value = s.name + (s.phone?(' — '+s.phone):''); suggestions.classList.add('hidden'); } } else { // try to match
            const val = manualInput.value.trim(); if(!val) return; const students = read(LS.students); let found = students.find(s=>s.name.toLowerCase()===val.toLowerCase()); if(!found) found = students.find(s=> (s.name + ' ' + (s.phone||'')).toLowerCase().includes(val.toLowerCase()) ); if(found){ manualSelectedId = found.id; manualInput.value = found.name + (found.phone?(' — '+found.phone):''); suggestions.classList.add('hidden'); }
        } }
      });
    }
  if($('#manual-search-btn')){ $('#manual-search-btn').addEventListener('click', ()=>{ const v = manualInput ? manualInput.value.trim() : ''; renderManualSuggestions(v); if(manualInput) manualInput.focus(); }); }
    if($('#manual-checkin')){ $('#manual-checkin').addEventListener('click', ()=>{
      const input = $('#manual-search'); const val = input ? input.value.trim() : '';
      let found = null;
      if(manualSelectedId) found = read(LS.students).find(s=>s.id===manualSelectedId);
      if(!found && val){ const students = read(LS.students); found = students.find(s=>s.name.toLowerCase()===val.toLowerCase()); if(!found) found = students.find(s=> (s.name + ' ' + (s.phone||'')).toLowerCase().includes(val.toLowerCase()) ); }
      if(!found) return alert('Student not found. Try selecting from suggestions.');
      // gather selected package (if any) only for display/persistence, not required for attendance
  const pkgSel = document.getElementById('stu-package-select');
  const pkgId = pkgSel ? pkgSel.value : null;
      recordAttendanceLocal(found.id, null, found.name);
      // clear student form package selection if present
      if(input) input.value=''; manualSelectedId = null;
    }); }

  // Admin panel removed from UI; no DOM wiring here

    // attach handlers for today's attendance list: delete button and click to open student modal
    const attList = $('#attendance-list'); if(attList){ attList.addEventListener('click', ev=>{
      const btn = ev.target.closest('button'); if(btn){ const action = btn.getAttribute('data-action'); if(action==='adel'){ const id = btn.getAttribute('data-id'); deleteAttendanceLocal(id); } return; }
      const li = ev.target.closest('li[data-student-id]'); if(li){ const sid = li.getAttribute('data-student-id'); if(sid) renderStudentModal(sid); }
    }); }
  }

  // add visual scroll indicators (top/bottom shadows) for group lists and wrapper
  function enhanceGroupScroll(){
    // group list shadows
    document.querySelectorAll('.group-list').forEach(el=>{
      const parent = el.closest('.student-group');
      if(!parent) return;
      function update(){
        if(el.scrollTop > 0) parent.classList.add('scrolled-top'); else parent.classList.remove('scrolled-top');
        if(el.scrollHeight > el.clientHeight + el.scrollTop + 1) parent.classList.add('scrolled-bottom'); else parent.classList.remove('scrolled-bottom');
      }
      // ensure single listener
      el.removeEventListener('scroll', update);
      el.addEventListener('scroll', update);
      // initial update
      setTimeout(update,30);
    });

    // wrapper shadows (in case groups overflow horizontally/vertically)
    const wrap = document.querySelector('.student-groups');
    if(wrap){
      function updateWrap(){
        if(wrap.scrollTop > 0) wrap.classList.add('scrolled-top'); else wrap.classList.remove('scrolled-top');
        if(wrap.scrollHeight > wrap.clientHeight + wrap.scrollTop + 1) wrap.classList.add('scrolled-bottom'); else wrap.classList.remove('scrolled-bottom');
      }
      wrap.removeEventListener('scroll', updateWrap);
      wrap.addEventListener('scroll', updateWrap);
      setTimeout(updateWrap,30);
    }
  }

  function showPanel(id){ $$('.panel').forEach(p=>p.classList.add('hidden')); const el = $('#'+id); if(el) el.classList.remove('hidden'); $$('.sidebar a').forEach(a=>a.classList.remove('active')); const active = Array.from($$('.sidebar a')).find(a=>a.getAttribute('href')==('#'+id)); if(active) active.classList.add('active'); }

  // enhance: when switching panels, smoothly scroll main to top for better UX
  (function patchShowPanel(){
    const orig = showPanel;
    window.showPanel = function(id){
      orig(id);
      const main = document.querySelector('.main');
      try{ if(main && main.scrollTo) main.scrollTo({top:0, behavior:'smooth'}); else if(main) main.scrollTop = 0; }catch(e){ if(main) main.scrollTop=0; }
    }
  })();

  async function init(){
    // if server available, pull state
    await pingServer(); if(serverOnline) await fetchState();
    // seed local if nothing
    // local storage versioning: set default if missing
    if(!localStorage.getItem('dtc_version')) localStorage.setItem('dtc_version','1');
    if(!localStorage.getItem(LS.students)) write(LS.students, []);
    if(!localStorage.getItem(LS.attendance)) write(LS.attendance, []);
  if(!localStorage.getItem(LS.deleted_att)) write(LS.deleted_att, []);
    if(!localStorage.getItem(LS.payments)) write(LS.payments, []);
  // fingerprint mappings removed — no fpmap initialization
  renderStudents(); renderCounts(); renderTransactions(); attach(); showPanel('dashboard');
    // periodic ping and sync
    setInterval(async ()=>{ const was = serverOnline; await pingServer(); if(serverOnline && !was){ await fetchState(); await syncLocalToServer(); renderStudents(); renderAttendance(); } }, 5000);
    // start clock in topbar
    startClock();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

// small helper: update header clock
function startClock(){
  const el = document.getElementById('clock'); if(!el) return; const fmt = d=>d.toLocaleString();
  function tick(){ const d = new Date(); el.textContent = d.toLocaleString(); }
  tick(); setInterval(tick,1000);
}
