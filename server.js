'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const TICK_HZ = 30;
const SNAPSHOT_HZ = 15;
const MAX_PLAYERS = 8;
const TRACK_LENGTH = 480;
const CHAR = [
  { hp:50, speed:12, damage:12 }, { hp:200, speed:8.6, damage:18 },
  { hp:20, speed:11, damage:10 }, { hp:35, speed:14, damage:8 },
  { hp:15, speed:12, damage:0 }, { hp:100, speed:13, damage:15 },
  { hp:150, speed:10, damage:22 }
];
const rooms = new Map();
const peers = new Map();
let lastLoopMs = 0, loopP95Ms = 0;
let lagExpectedAt = Date.now() + 1000, lagSamples = [];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rand=(a,b)=>crypto.randomInt(a,b);
const id=()=>crypto.randomBytes(8).toString('hex');
const roomCode=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const safeName=v=>String(v||'러너').replace(/[<>]/g,'').trim().slice(0,20)||'러너';
const send=(ws,obj)=>{ if(ws.readyState===1) ws.send(JSON.stringify(obj)); };
const reply=(ws,requestId,ok,result={},error='')=>send(ws,{type:'reply',requestId,ok,result,error});
function getRoom(peer){return peer.roomId?rooms.get(peer.roomId):null}
function aliveHumans(room){return [...room.players.values()].filter(p=>p.connected)}
function playerPublic(p){return {id:p.id,nick:p.nick,isHost:p.isHost,ready:p.ready}}
function playerState(p){
 return {id:p.id,nick:p.nick,charId:p.charId,x:p.x,dist:p.dist,lap:p.lap,hp:p.hp,maxHp:p.maxHp,
  frozen:p.frozen,confused:p.confused,stun:p.stun,skillCd:p.skillCd,jumpHeight:p.jumpHeight,
  dead:p.dead,finished:p.finished,pushTime:p.pushTime,pushX:p.pushX,pushDist:p.pushDist,pushSpeed:p.pushSpeed,
  yaw:p.yaw,ready:p.ready,isHost:p.isHost};
}
function makePlayer(ws,nick,isHost=false){
 const charId=rand(0,CHAR.length), c=CHAR[charId];
 return {id:id(),ws,nick:safeName(nick),isHost,ready:false,connected:true,charId,x:0,dist:0,lap:1,
  hp:c.hp,maxHp:c.hp,frozen:0,confused:0,stun:0,skillCd:0,jumpHeight:0,jumpVelocity:0,
  dead:false,finished:false,respawnAt:0,pushTime:0,pushX:0,pushDist:0,pushSpeed:15,
  yaw:0,input:{forward:0,side:0,yaw:0,pitch:0,jump:false},lastInput:Date.now(),lastAction:0};
}
function snapshot(room,selfId){
 return {phase:room.phase,selfId,room:{roomId:room.id,name:room.name,maxPlayers:MAX_PLAYERS},
  players:[...room.players.values()].filter(p=>p.connected).map(playerState),
  bots:[],turrets:room.turrets.map(t=>({...t})),winnerId:room.winnerId||null};
}
function broadcastRoom(room,type='room:snapshot'){
 for(const p of room.players.values()) if(p.connected) send(p.ws,{type,snapshot:snapshot(room,p.id)});
}
function event(room,data){
 for(const p of room.players.values()) if(p.connected) send(p.ws,{type:'game:event',...data});
}
function notice(room,message,targetId){
 const p=room.players.get(targetId);
 if(p?.connected) send(p.ws,{type:'room:notice',message});
}
function detach(peer){
 const room=getRoom(peer); if(!room)return;
 const p=room.players.get(peer.playerId);
 if(p){p.connected=false;room.players.delete(p.id);}
 peer.roomId=null;peer.playerId=null;
 if(room.players.size===0){rooms.delete(room.id);return;}
 if(![...room.players.values()].some(x=>x.isHost)){const next=room.players.values().next().value;next.isHost=true;}
 broadcastRoom(room);
}
function enterRoom(peer,room,nick){
 const p=makePlayer(peer.ws,nick,room.players.size===0);
 room.players.set(p.id,p);peer.roomId=room.id;peer.playerId=p.id;
 broadcastRoom(room);
 return {roomId:room.id,playerId:p.id};
}
function listRooms(){
 return [...rooms.values()].filter(r=>r.phase==='waiting').map(r=>({
  roomId:r.id,name:r.name,hostName:[...r.players.values()].find(p=>p.isHost)?.nick||'방장',
  humans:aliveHumans(r).length,maxPlayers:MAX_PLAYERS,passwordProtected:!!r.password,phase:r.phase
 }));
}
function createRoom(peer,d){
 const roomId=roomCode();
 const room={id:roomId,name:safeName(d.name||'새로운 레이스 방'),password:String(d.password||'').slice(0,32),
  phase:'waiting',players:new Map(),turrets:[],iceProjectiles:[],iceZones:[],projectiles:[],winnerId:null,createdAt:Date.now()};
 rooms.set(roomId,room);
 return enterRoom(peer,room,d.nick);
}
function joinRoom(peer,d){
 const room=rooms.get(String(d.roomId||'').toUpperCase());
 if(!room)throw Error('방을 찾을 수 없습니다.');
 if(room.phase!=='waiting')throw Error('이미 레이스가 시작된 방입니다.');
 if(room.players.size>=MAX_PLAYERS)throw Error('방이 가득 찼습니다.');
 if(room.password&&room.password!==String(d.password||''))throw Error('방 비밀번호가 올바르지 않습니다.');
 return enterRoom(peer,room,d.nick);
}
function startRoom(room){
 const humans=aliveHumans(room);
 if(humans.length<2)throw Error('실제 참가자가 2명 이상이어야 합니다.');
 if(!humans.every(p=>p.ready))throw Error('모든 플레이어가 준비해야 합니다.');
 room.phase='racing';room.turrets=[];room.projectiles=[];room.iceProjectiles=[];room.iceZones=[];room.winnerId=null;
 humans.forEach((p,i)=>{p.x=(i-(humans.length-1)/2)*2;p.dist=0;p.lap=1;p.finished=false;p.dead=false;p.hp=p.maxHp;p.frozen=p.confused=p.stun=p.skillCd=0;p.jumpHeight=p.jumpVelocity=0;p.input={forward:0,side:0,yaw:0,pitch:0,jump:false};});
 broadcastRoom(room,'race:started');
}
function damagePlayer(room, source, target, damage, push={}) {
 if(!target || target.charId===4 || target.dead || target.finished) return false; // 시민은 싱글플레이와 동일하게 상시 무적
 target.hp=Math.max(0,target.hp-damage);
 if(push.time){target.pushTime=push.time;target.pushX=push.x||0;target.pushDist=push.dist||0;target.pushSpeed=push.speed||15;}
 if(target.hp<=0){target.dead=true;target.respawnAt=Date.now()+3000;event(room,{event:'death',targetId:target.id,ownerId:source?.id});}
 else event(room,{event:'hit',targetId:target.id,ownerId:source?.id,x:target.x,dist:target.dist,damage});
 return true;
}
function spawnAttackProjectile(room,p,yaw,pitch=0){
 const c=CHAR[p.charId],cp=Math.cos(pitch),dirX=-Math.sin(yaw)*cp,dirDist=Math.cos(yaw)*cp;
 const speed=c.projectileSpeed||42;
 const projectile={id:id(),ownerId:p.id,charId:p.charId,x:p.x+dirX*.8,dist:p.dist+dirDist*.8,
  y:1.35+p.jumpHeight,vx:dirX*speed,vDist:dirDist*speed,vy:Math.sin(pitch)*speed,timer:1.5,damage:c.damage,kind:'attack'};
 room.projectiles.push(projectile);
 event(room,{event:'attack-projectile',ownerId:p.id,charId:p.charId,x:projectile.x,dist:projectile.dist,y:projectile.y,vx:projectile.vx,vDist:projectile.vDist,vy:0,timer:1.5});
}
function shieldBash(room,p,yaw,damage=22){
 const dx=-Math.sin(yaw),dd=Math.cos(yaw),range=4.6,width=2.0;
 for(const t of room.players.values()){
  if(t.id===p.id||t.dead||t.finished||t.charId===4)continue;
  const rx=t.x-p.x,rd=t.dist-p.dist,forward=rx*dx+rd*dd,lateral=Math.abs(rx*dd-rd*dx);
  if(forward>0.15&&forward<range&&lateral<width){
   t.frozen=0;
   damagePlayer(room,p,t,damage,{time:.72,x:dx,dist:dd,speed:15});
   event(room,{event:'bash',targetId:t.id,ownerId:p.id,x:t.x,dist:t.dist});
  }
 }
}
function handleAction(room,p,d){
 const now=Date.now();
 if(p.dead||p.finished||p.frozen>0)return;
 const yaw=Number.isFinite(+d.yaw)?+d.yaw:p.yaw;
 if(d.action==='attack'){
  if(now-p.lastAttack<320)return;
  p.lastAttack=now;
  if(p.charId===6) shieldBash(room,p,yaw);
  else spawnAttackProjectile(room,p,yaw,clamp(Number(d.pitch)||0,-.85,.85));
  return;
 }
 if(d.action!=='skill')return;
 if(p.skillCd>0||p.charId===1||p.charId===4)return;
 const c=CHAR[p.charId];
 if(p.charId===3&&room.turrets.filter(t=>t.ownerId===p.id).length>=5)return;
 p.skillCd=c.skillCd;
 if(p.charId===0){
  for(const t of room.players.values()){
   if(t.id===p.id||t.dead||t.finished||t.charId===4)continue;
   if(Math.hypot(t.x-p.x,t.dist-p.dist)<=16){t.confused=4;event(room,{event:'rage',targetId:t.id,x:t.x,dist:t.dist,ownerId:p.id});}
  }
 }else if(p.charId===2){
  const pitch=clamp(Number(d.pitch)||0,-.85,.85),cp=Math.cos(pitch),dirX=-Math.sin(yaw)*cp,dirDist=Math.cos(yaw)*cp;
  // 투척자의 현재 이동 속도를 더해 달리면서 던지면 더 멀리 날아간다.
  const f=clamp(p.input.forward,-1,1),side=clamp(p.input.side,-1,1),speed=c.speed;
  const runnerVX=(-Math.sin(yaw)*f+Math.cos(yaw)*side)*speed*1.25;
  const runnerVDist=(Math.cos(yaw)*f+Math.sin(yaw)*side)*speed*2.2;
  const g={id:id(),ownerId:p.id,x:p.x+dirX*.7,dist:p.dist+dirDist*.7,y:1.65+p.jumpHeight,
   vx:dirX*24+runnerVX,vDist:dirDist*24+runnerVDist,vy:6.5+Math.sin(pitch)*24,timer:1.3};
  room.iceProjectiles.push(g);
  event(room,{event:'ice-throw',...g});
 }else if(p.charId===3){
  const dirX=-Math.sin(yaw),dirDist=Math.cos(yaw);
  const t={id:id(),ownerId:p.id,x:clamp(p.x+dirX*2.2,-13,13),dist:p.dist+dirDist*2.2,hp:30,maxHp:30,cd:.2};
  room.turrets.push(t);event(room,{event:'turret-place',targetId:p.id,turret:{...t},x:t.x,dist:t.dist});
 }else if(p.charId===5){
  for(const t of room.players.values()){
   if(t.id===p.id||t.dead||t.finished||t.charId===4)continue;
   if(Math.abs(t.dist-p.dist)<20){t.stun=2;event(room,{event:'royal',targetId:t.id,x:t.x,dist:t.dist,ownerId:p.id});}
  }
 }else if(p.charId===6){shieldBash(room,p,yaw,8);}
}
function updateProjectiles(room,dt){
 for(let i=room.projectiles.length-1;i>=0;i--){
  const b=room.projectiles[i];b.timer-=dt;b.x+=b.vx*dt;b.dist+=b.vDist*dt;b.y+=b.vy*dt;
  let hit=false;
  for(const t of room.players.values()){
   if(t.id===b.ownerId||t.dead||t.finished)continue;
   if(Math.hypot(t.x-b.x,t.dist-b.dist)<1.4&&Math.abs(1.1-b.y)<1.5){
    damagePlayer(room,room.players.get(b.ownerId),t,b.damage);
    event(room,{event:'shot',targetId:t.id,ownerId:b.ownerId,x:b.x,dist:b.dist,charId:b.charId});hit=true;break;
   }
  }
  if(!hit&&b.kind!=='turret'){
   for(let ti=room.turrets.length-1;ti>=0;ti--){
    const tu=room.turrets[ti];
    if(tu.ownerId===b.ownerId)continue;
    if(Math.hypot(tu.x-b.x,tu.dist-b.dist)<1.05&&b.y<2.4){
     tu.hp=Math.max(0,tu.hp-b.damage);hit=true;
     if(tu.hp<=0){event(room,{event:'turret-destroy',turretId:tu.id,x:tu.x,dist:tu.dist});room.turrets.splice(ti,1);}
     break;
    }
   }
  }
  if(hit||b.timer<=0)room.projectiles.splice(i,1);
 }
}
function updateTurrets(room,dt){
 for(const tu of room.turrets){
  tu.cd=(tu.cd||0)-dt;
  let target=null,minD=24;
  for(const p of room.players.values()){
   if(p.id===tu.ownerId||p.dead||p.finished)continue;
   const d=Math.hypot(p.x-tu.x,p.dist-tu.dist);
   if(d<minD){minD=d;target=p;}
  }
  if(target&&tu.cd<=0){
   tu.cd=.55;const dx=target.x-tu.x,dd=target.dist-tu.dist,len=Math.hypot(dx,dd)||1;
   room.projectiles.push({id:id(),ownerId:tu.ownerId,charId:3,x:tu.x,y:.9,dist:tu.dist,
    vx:dx/len*48,vDist:dd/len*48,vy:0,timer:.8,damage:7,kind:'turret'});
   event(room,{event:'turret-shot',ownerId:tu.ownerId,targetId:target.id,x:tu.x,dist:tu.dist});
  }
 }
}
function updateIceProjectiles(room,dt){
 for(let i=room.iceProjectiles.length-1;i>=0;i--){
  const g=room.iceProjectiles[i];g.timer-=dt;g.vy-=22*dt;g.x+=g.vx*dt;g.dist+=g.vDist*dt;g.y+=g.vy*dt;
  if(g.y<=.2||g.timer<=0){
   const zone={id:id(),x:g.x,dist:g.dist,radius:5.5,life:4.5,ownerId:g.ownerId};room.iceZones.push(zone);
   for(const target of room.players.values()){
    if(target.id===g.ownerId||target.dead||target.finished||target.charId===4)continue;
    if(Math.hypot(target.x-g.x,target.dist-g.dist)<=zone.radius){target.frozen=3;event(room,{event:'ice',targetId:target.id,x:target.x,dist:target.dist,ownerId:g.ownerId});}
   }
   event(room,{event:'ice-land',x:g.x,dist:g.dist,ownerId:g.ownerId,projectileId:g.id,radius:zone.radius,life:zone.life});
   room.iceProjectiles.splice(i,1);
  }
 }
 for(let i=room.iceZones.length-1;i>=0;i--){
  const z=room.iceZones[i];z.life-=dt;
  for(const target of room.players.values()){
   if(target.id===z.ownerId||target.dead||target.finished||target.charId===4||target.frozen>0)continue;
   if(Math.hypot(target.x-z.x,target.dist-z.dist)<=z.radius){target.frozen=3;event(room,{event:'ice',targetId:target.id,x:target.x,dist:target.dist,ownerId:z.ownerId});}
  }
  if(z.life<=0)room.iceZones.splice(i,1);
 }
}

function updatePlayer(room,p,dt,now){
 if(!p.connected)return;
 if(now-p.lastInput>1000)p.input={forward:0,side:0,yaw:p.yaw,pitch:0,jump:false};
 p.frozen=Math.max(0,p.frozen-dt);p.confused=Math.max(0,p.confused-dt);p.stun=Math.max(0,p.stun-dt);p.skillCd=Math.max(0,p.skillCd-dt);
 if(p.dead){if(now>=p.respawnAt){p.dead=false;p.hp=p.maxHp;p.x=0;p.dist=0;p.lap=1;p.pushTime=0;event(room,{event:'respawn',targetId:p.id});}return;}
 if(p.finished)return;
 if(p.pushTime>0){const step=Math.min(dt,p.pushTime);p.x=clamp(p.x+p.pushX*p.pushSpeed*step,-15,15);p.dist=Math.max(0,p.dist+p.pushDist*p.pushSpeed*step);p.pushTime=Math.max(0,p.pushTime-dt);}
 else if(p.frozen<=0&&p.stun<=0){
  let f=clamp(p.input.forward,-1,1),s=clamp(p.input.side,-1,1);
  if(p.confused>0){f=-f;s=-s;}
  const c=CHAR[p.charId],yaw=p.input.yaw;
  p.x=clamp(p.x+(-Math.sin(yaw)*f+Math.cos(yaw)*s)*c.speed*dt*1.25,-14,14);
  p.dist=Math.max(0,p.dist+(Math.cos(yaw)*f+Math.sin(yaw)*s)*c.speed*dt*2.2);
 }
 if(p.input.jump&&p.jumpHeight<.05){p.jumpVelocity=7;}
 p.jumpVelocity-=18*dt;p.jumpHeight=Math.max(0,p.jumpHeight+p.jumpVelocity*dt);
 if(p.jumpHeight===0)p.jumpVelocity=0;
 if(p.dist>=TRACK_LENGTH){p.dist-=TRACK_LENGTH;p.lap++;p.charId=rand(0,CHAR.length);p.maxHp=CHAR[p.charId].hp;p.hp=p.maxHp;p.skillCd=0;event(room,{event:'lap',targetId:p.id,lap:p.lap,charId:p.charId,maxHp:p.maxHp});}
 if(p.lap>3){p.finished=true;event(room,{event:'finish',targetId:p.id,nick:p.nick});}
}
function tick(){
 const now=Date.now(),dt=clamp((now-(lastLoopMs||now))/1000,0,.08);lastLoopMs=now;
 for(const room of rooms.values()){
  if(room.phase!=='racing')continue;
  for(const p of room.players.values())updatePlayer(room,p,dt,now);
  updateIceProjectiles(room,dt);updateProjectiles(room,dt);updateTurrets(room,dt);
  if(!room.winnerId){const winner=[...room.players.values()].find(p=>p.finished);if(winner){room.winnerId=winner.id;room.phase='finished';broadcastRoom(room,'race:finished');}}
 }
}
function handle(ws,peer,d){
 try{
  if(!d||typeof d.type!=='string')return;
  if(d.type==='net:ping'){send(ws,{type:'net:pong',clientTime:d.clientTime,eventLoopP95Ms:loopP95Ms});return;}
  if(d.type==='room:heartbeat')return;
  if(d.type==='rooms:list'){reply(ws,d.requestId,true,{rooms:listRooms()});return;}
  if(d.type==='room:create'){if(getRoom(peer))detach(peer);const result=createRoom(peer,d);reply(ws,d.requestId,true,result);return;}
  if(d.type==='room:join'){if(getRoom(peer))detach(peer);const result=joinRoom(peer,d);reply(ws,d.requestId,true,result);return;}
  if(d.type==='room:quick'){
   if(getRoom(peer))detach(peer);
   let room=[...rooms.values()].find(r=>r.phase==='waiting'&&!r.password&&r.players.size<MAX_PLAYERS);
   if(!room){const rid=roomCode();room={id:rid,name:'빠른 매치',password:'',phase:'waiting',players:new Map(),turrets:[],iceProjectiles:[],iceZones:[],projectiles:[],winnerId:null,createdAt:Date.now()};rooms.set(rid,room);}
   const result=enterRoom(peer,room,d.nick);reply(ws,d.requestId,true,result);return;
  }
  const room=getRoom(peer),p=room?.players.get(peer.playerId);
  if(d.type==='room:leave'){detach(peer);reply(ws,d.requestId,true,{});return;}
  if(!room||!p)throw Error('먼저 방에 입장해 주세요.');
  if(d.type==='room:ready'){if(room.phase!=='waiting')throw Error('이미 시작된 레이스입니다.');p.ready=!!d.ready;broadcastRoom(room);reply(ws,d.requestId,true,{});return;}
  if(d.type==='room:start'){if(!p.isHost)throw Error('방장만 시작할 수 있습니다.');startRoom(room);reply(ws,d.requestId,true,{});return;}
  if(d.type==='input'){
   if(room.phase!=='racing'||p.finished||p.dead)return;
   p.input={forward:clamp(Number(d.forward)||0,-1,1),side:clamp(Number(d.side)||0,-1,1),
    yaw:clamp(Number(d.yaw)||0,-Math.PI*4,Math.PI*4),pitch:clamp(Number(d.pitch)||0,-1,1),jump:!!d.jump};
   p.yaw=p.input.yaw;p.lastInput=Date.now();return;
  }
  if(d.type==='action'){if(room.phase==='racing')handleAction(room,p,d);return;}
 }catch(e){if(d?.requestId)reply(ws,d.requestId,false,{},e.message);else send(ws,{type:'room:notice',message:e.message||'요청 오류'});}
}
const server=http.createServer((req,res)=>{
 if(req.url==='/health'||req.url==='/'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,service:'blood-pressure-marathon',rooms:rooms.size,tickHz:TICK_HZ,snapshotHz:SNAPSHOT_HZ}));return;}
 res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({server,path:'/ws',perMessageDeflate:false,maxPayload:16*1024});
wss.on('connection',(ws,req)=>{
 const peer={ws,roomId:null,playerId:null};peers.set(ws,peer);
 ws.on('message',raw=>{let d;try{d=JSON.parse(raw.toString());}catch{return;}handle(ws,peer,d);});
 ws.on('close',()=>{detach(peer);peers.delete(ws);});
 ws.on('error',()=>{detach(peer);peers.delete(ws);});
});
setInterval(tick,1000/TICK_HZ);
setInterval(()=>{
 const now=Date.now(), lag=Math.max(0,now-lagExpectedAt);
 lagSamples.push(lag); if(lagSamples.length>60)lagSamples.shift();
 const sorted=[...lagSamples].sort((a,b)=>a-b);
 loopP95Ms=sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]:0;
 lagExpectedAt=now+1000;
},1000);
setInterval(()=>{
 for(const room of rooms.values())if(room.phase==='waiting'||room.phase==='racing')broadcastRoom(room);
},1000/SNAPSHOT_HZ);
setInterval(()=>{
 const now=Date.now();
 for(const [id,room] of rooms){if(room.phase==='waiting'&&now-room.createdAt>6*60*60*1000&&room.players.size===0)rooms.delete(id);}
},60000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Multiplayer server listening on ${PORT}`));
process.on('SIGTERM',()=>{for(const ws of wss.clients)ws.close(1001,'Server shutting down');server.close(()=>process.exit(0));});
