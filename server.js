const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

const participants = new Map();

app.use(express.json());
app.use(express.static(__dirname));

function cleanName(v){
  return String(v || '').replace(/[<>]/g,'').trim().slice(0,20);
}
function list(){
  return [...participants.entries()]
    .map(([id,u])=>({id,name:u.name,joinedAt:u.joinedAt}))
    .sort((a,b)=>a.joinedAt-b.joinedAt);
}
function broadcast(){ io.emit('participants', list()); }

app.get('/health', (_req,res)=>res.json({ok:true, participants:participants.size}));

io.on('connection', socket=>{
  socket.emit('participants', list());

  socket.on('join_auction', (payload={}, callback=()=>{})=>{
    const name = cleanName(payload.name);
    if(!name) return callback({ok:false,message:'닉네임을 입력해주세요.'});

    const duplicate = [...participants.entries()].some(
      ([id,u])=>id!==socket.id && u.name.toLowerCase()===name.toLowerCase()
    );
    if(duplicate) return callback({ok:false,message:'현재 접속 중인 닉네임입니다.'});

    participants.set(socket.id,{name,joinedAt:Date.now()});
    callback({ok:true,name});
    broadcast();
  });

  socket.on('disconnect', ()=>{
    if(participants.delete(socket.id)) broadcast();
  });
});

app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'index.html')));

server.listen(PORT,'0.0.0.0',()=>console.log(`sanak-auction running on ${PORT}`));
