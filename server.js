const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SYNC_KEY || 'dev_key'; // change in production to a strong secret
const DATA_FILE = path.join(__dirname, 'data.json');

const app = express();
app.use(cors());
app.use(express.json());

function readData(){
  try{
    if(!fs.existsSync(DATA_FILE)){
      const initial = { students: [], attendance: [], transactions: [], products: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
      return initial;
    }
    const txt = fs.readFileSync(DATA_FILE,'utf8');
    return JSON.parse(txt || '{}');
  }catch(e){
    console.error('readData error', e);
    return { students: [], attendance: [], transactions: [], products: [] };
  }
}

function writeData(data){
  try{
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }catch(e){ console.error('writeData error', e); }
}

// Serve static files from the project directory
app.use(express.static(path.join(__dirname)));

app.get('/api/ping',(req,res)=>{ res.json({ok:true, time:new Date().toISOString()}); });

app.get('/api/state',(req,res)=>{
  const data = readData();
  res.json({ok:true, state:data});
});

// simple API key middleware for write endpoints
function requireApiKey(req,res,next){
  const key = req.headers['x-api-key'] || req.query.api_key || req.headers['authorization'];
  if(!key || String(key) !== String(API_KEY)) return res.status(401).json({ok:false,error:'unauthorized'});
  next();
}

app.post('/api/attendance', requireApiKey, (req,res)=>{
  const { studentId, name, time } = req.body || {};
  const data = readData();
  // determine phone from studentId if available
  let phone = null;
  if(studentId && Array.isArray(data.students)){
    const s = data.students.find(x=>x.id===studentId);
    if(s) phone = s.phone || null;
  }
  // prevent duplicate for same phone today
  if(phone){
    const today = (new Date((time||new Date()).toString())).toISOString().slice(0,10);
    data.attendance = data.attendance || [];
    const dup = data.attendance.find(a=> (a.time||'').slice(0,10)===today && a.phone && a.phone===phone );
    if(dup) return res.status(409).json({ok:false,error:'duplicate', message:'Attendance already exists for this phone today'});
  }
  const rec = { id: 'a_'+Math.random().toString(36).slice(2,9), studentId: studentId||null, name: name||null, phone: phone||null, time: time||new Date().toISOString() };
  data.attendance = data.attendance || [];
  data.attendance.unshift(rec);
  writeData(data);
  res.json({ok:true, rec});
});

// delete attendance record by id
app.post('/api/attendance/delete', requireApiKey, (req,res)=>{
  const { id } = req.body || {};
  if(!id) return res.status(400).json({ok:false,error:'id required'});
  const data = readData(); data.attendance = data.attendance || [];
  const idx = data.attendance.findIndex(a=>a.id===id);
  if(idx===-1) return res.status(404).json({ok:false,error:'not found'});
  data.attendance.splice(idx,1);
  writeData(data);
  res.json({ok:true});
});

// sync: merge client-side data into server storage (basic merge)
app.post('/api/sync', requireApiKey, (req,res)=>{
  const payload = req.body || {};
  const data = readData();
  // merge students (simple, add any unknown by id)
  if(Array.isArray(payload.students)){
    data.students = data.students || [];
    const known = new Set(data.students.map(s=>s.id));
    const existingPhones = new Set((data.students||[]).map(s=> (s.phone||'').trim()).filter(Boolean));
    payload.students.forEach(s=>{
      if(!s || !s.id) return;
      if(known.has(s.id)) return;
      const phone = (s.phone||'').trim();
      if(phone && existingPhones.has(phone)){
        // skip adding student with duplicate phone
        return;
      }
      data.students.push(s);
      if(phone) existingPhones.add(phone);
    });
  }
  // no fingerprint maps to merge — this server instance currently uses manual check-in
  // merge attendance (prepend any that don't exist by id)
  data.attendance = data.attendance || [];
  if(Array.isArray(payload.attendance)){
    const knownA = new Set(data.attendance.map(a=>a.id));
    payload.attendance.forEach(a=>{ if(a && a.id && !knownA.has(a.id)) data.attendance.unshift(a); });
  }
  // merge transactions
  data.transactions = data.transactions || [];
  if(Array.isArray(payload.transactions)){
    const knownT = new Set(data.transactions.map(t=>t.id));
    payload.transactions.forEach(t=>{ if(t && t.id && !knownT.has(t.id)) data.transactions.unshift(t); });
  }
  writeData(data);
  res.json({ok:true, state:data});
});

app.listen(PORT, ()=>{
  console.log(`Server running on port ${PORT} — serving ${__dirname}`);
  console.log(`API key: ${API_KEY.substr(0,6)}... (set SYNC_KEY env var in production)`);
});
