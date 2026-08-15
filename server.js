
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{pingInterval:12000,pingTimeout:25000});
const PORT=process.env.PORT||3000;
const START=1000000;

app.use(express.static(__dirname));
app.get('/health',(req,res)=>res.json({ok:true}));

const G={
 players:Array(10).fill(null), gameStarted:false, dealing:false, settling:false,
 roundNo:1, dealerHand:[], deck:[], turnOrder:[], turnIndex:0, activeHandIndex:0,
 status:'사람모양만 눌러 착석하세요 · 0 / 10', countdown:null, hideHole:false
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function makeDeck(){
 const suits=['♠','♥','♦','♣'],ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],d=[];
 for(let k=0;k<6;k++)for(const s of suits)for(const r of ranks)d.push({s,r});
 for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}
 return d;
}
function handValue(cards){
 let t=0,a=0; for(const c of cards){if(c.r==='A'){t+=11;a++}else if(['K','Q','J'].includes(c.r))t+=10;else t+=Number(c.r)}
 while(t>21&&a){t-=10;a--} return t;
}
function rankNumber(r){return r==='A'?14:r==='K'?13:r==='Q'?12:r==='J'?11:Number(r)}
function pairOdds(cards){
 if(!cards||cards.length<2||cards[0].r!==cards[1].r)return 0;
 if(cards[0].s===cards[1].s)return 25;
 const red=s=>s==='♥'||s==='♦';
 return red(cards[0].s)===red(cards[1].s)?12:6;
}
function trioOdds(cards,up){
 if(!cards||cards.length<2||!up)return 0;
 const cs=[cards[0],cards[1],up],rs=cs.map(c=>rankNumber(c.r)).sort((a,b)=>a-b);
 const flush=cs.every(c=>c.s===cs[0].s),trips=rs[0]===rs[2];
 const straight=(rs[0]+1===rs[1]&&rs[1]+1===rs[2])||(rs[0]===2&&rs[1]===3&&rs[2]===14)||(rs[0]===12&&rs[1]===13&&rs[2]===14);
 if(trips&&flush)return 100;if(straight&&flush)return 40;if(trips)return 30;if(straight)return 10;if(flush)return 5;return 0;
}
function natural(h){return h.cards.length===2&&handValue(h.cards)===21&&!h.split}
function canSplit(p,h){
 if(!p||!h||h.cards.length!==2||h.split)return false;
 const f=['J','Q','K'],ok=h.cards[0].r===h.cards[1].r||(f.includes(h.cards[0].r)&&f.includes(h.cards[1].r));
 return ok&&p.bank>=h.bet;
}
function canDouble(p,h){return !!(p&&h&&h.cards.length===2&&!h.doubled&&p.bank>=h.bet)}
function byToken(token){return G.players.findIndex(p=>p&&p.token===token)}
function clearStaleWaitingSeats(){
 if(G.gameStarted)return false;
 const now=Date.now();let changed=false;
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];
   if(!p||p.connected!==false||!p.disconnectedAt)continue;
   const grace=p.confirmed?30000:15000;
   if(now-p.disconnectedAt>=grace){
     G.players[i]=null;
     changed=true;
   }
 }
 return changed;
}
function publicPlayer(p){if(!p)return null; const {token,socketId,...q}=p; return q}
function snapshotFor(socket){
 const mySeat=byToken(socket.data.token);
 let turnSeat=G.turnIndex<G.turnOrder.length?G.turnOrder[G.turnIndex]:null;
 let p=turnSeat!==null?G.players[turnSeat]:null,h=p&&p.hands?p.hands[G.activeHandIndex]:null;
 return {
   players:G.players.map(publicPlayer),
   dealerHand:G.dealerHand.map((c,i)=>i===1&&G.hideHole?{hidden:true}:c),
   hideHole:G.hideHole,gameStarted:G.gameStarted,dealing:G.dealing,settling:G.settling,
   roundNo:G.roundNo,status:G.status,turnSeat,activeHandIndex:G.activeHandIndex,
   canSplit:turnSeat===mySeat&&canSplit(p,h),canDouble:turnSeat===mySeat&&canDouble(p,h),mySeat
 };
}
function broadcast(){
 for(const s of io.sockets.sockets.values()) s.emit('state',snapshotFor(s));
}
function updateWaitingStatus(){
 const count=G.players.filter(Boolean).length,done=G.players.filter(p=>p&&p.confirmed).length;
 if(!G.gameStarted) G.status=count<10?`사람모양만 눌러 착석하세요 · ${count} / 10`:`10명 착석 완료 · 베팅 완료 ${done} / 10`;
}
function maybeStart(){
 const seated=G.players.filter(Boolean);
 if(!G.gameStarted&&seated.length===10&&seated.every(p=>p.confirmed)&&!G.countdown){
   let n=5; G.status=`전원 베팅 완료 · ${n}초 후 패 배분`; broadcast();
   G.countdown=setInterval(()=>{
     n--; G.status=`전원 베팅 완료 · ${n}초 후 패 배분`; broadcast();
     if(n<=0){clearInterval(G.countdown);G.countdown=null;startRound()}
   },1000);
 }
}
async function startRound(){
 G.gameStarted=true;G.dealing=true;G.settling=false;G.deck=makeDeck();G.dealerHand=[];G.turnOrder=[];G.turnIndex=0;G.activeHandIndex=0;G.hideHole=false;
 G.players.forEach((p,i)=>{if(!p)return;p.hands=[{cards:[],bet:p.bet.main,state:'PLAY',doubled:false,split:false,result:''}];p.initialCards=[];p.inRound=true;p.roundResult='';p.sideResult='';G.turnOrder.push(i)});
 G.status=`ROUND ${G.roundNo} · 딜러 오픈카드`;G.dealerHand.push(G.deck.pop());broadcast();await sleep(500);
 for(const i of G.turnOrder){G.status=`ROUND ${G.roundNo} · ${G.players[i].name} 첫 번째 카드`;G.players[i].hands[0].cards.push(G.deck.pop());broadcast();await sleep(330)}
 G.status=`ROUND ${G.roundNo} · 딜러 비하인드 카드`;G.dealerHand.push(G.deck.pop());G.hideHole=true;broadcast();await sleep(500);
 for(const i of G.turnOrder){
   const p=G.players[i],h=p.hands[0];G.status=`ROUND ${G.roundNo} · ${p.name} 두 번째 카드`;h.cards.push(G.deck.pop());p.initialCards=h.cards.map(c=>({...c}));
   if(handValue(h.cards)===21)h.state='STAND';broadcast();await sleep(330);
 }
 G.dealing=false;G.status='딜링 완료 · 플레이 시작';broadcast();await sleep(350);advanceTurn();
}
function current(){if(G.turnIndex>=G.turnOrder.length)return [null,null,null];const seat=G.turnOrder[G.turnIndex],p=G.players[seat],h=p?.hands?.[G.activeHandIndex];return[seat,p,h]}
function advanceTurn(){
 while(G.turnIndex<G.turnOrder.length){
   const p=G.players[G.turnOrder[G.turnIndex]];
   while(G.activeHandIndex<p.hands.length&&p.hands[G.activeHandIndex].state!=='PLAY')G.activeHandIndex++;
   if(G.activeHandIndex<p.hands.length)break;
   G.turnIndex++;G.activeHandIndex=0;
 }
 if(G.turnIndex>=G.turnOrder.length){G.status='모든 플레이어 완료 · 딜러 비하인드 오픈';broadcast();revealDealer();return}
 const [seat,p,h]=current();G.status=`${p.name} 차례 · HIT / STAND / DOUBLE / SPLIT`;broadcast();
}
async function revealDealer(){
 G.settling=true;G.hideHole=false;G.status='딜러 비하인드 카드 오픈';broadcast();await sleep(650);
 while(handValue(G.dealerHand)<17){G.status=`딜러 ${handValue(G.dealerHand)} · HIT`;G.dealerHand.push(G.deck.pop());broadcast();await sleep(600)}
 G.status=`딜러 ${handValue(G.dealerHand)} · 정산`;broadcast();await sleep(500);settle();
}
function settle(){
 const dv=handValue(G.dealerHand),db=dv>21,dbj=G.dealerHand.length===2&&dv===21;
 for(const p of G.players){
   if(!p||!p.inRound)continue;
   const texts=[];
   for(let i=0;i<p.hands.length;i++){
     const h=p.hands[i],v=handValue(h.cards);let ret=0,res='';
     if(v>21)res='LOSE';
     else if(natural(h)&&dbj){ret=h.bet;res='PUSH'}
     else if(natural(h)&&!dbj){ret=h.bet*2.5;res='BLACKJACK'}
     else if(dbj)res='LOSE';
     else if(db){ret=h.bet*2;res='WIN'}
     else if(v>dv){ret=h.bet*2;res='WIN'}
     else if(v===dv){ret=h.bet;res='PUSH'}
     else res='LOSE';
     p.bank+=ret;h.result=res;texts.push(`${p.hands.length>1?'H'+(i+1)+' ':''}${res}`);
   }
   if(p.bet.pair>0){const o=pairOdds(p.initialCards);if(o){p.bank+=p.bet.pair*(o+1);texts.push(`PP ${o}:1`)}else texts.push('PP LOSE')}
   if(p.bet.trio>0){const o=trioOdds(p.initialCards,G.dealerHand[0]);if(o){p.bank+=p.bet.trio*(o+1);texts.push(`21+3 ${o}:1`)}else texts.push('21+3 LOSE')}
   p.roundResult=texts.join(' · ');
 }
 G.settling=false;G.status=`ROUND ${G.roundNo} 정산 완료 · 다음 라운드 준비`;broadcast();setTimeout(nextRound,4200);
}
function nextRound(){
 G.gameStarted=false;G.dealing=false;G.settling=false;G.dealerHand=[];G.hideHole=false;G.turnOrder=[];G.turnIndex=0;G.activeHandIndex=0;G.roundNo++;
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];
   if(!p)continue;
   if(p.connected===false){
     G.players[i]=null;
     continue;
   }
   p.hands=[];p.initialCards=[];p.inRound=false;p.bet={main:0,pair:0,trio:0};
   p.betLast={main:0,pair:0,trio:0};p.history=[];p.confirmed=false;p.roundResult='';
 }
 updateWaitingStatus();
 G.status=`ROUND ${G.roundNo} · 다음 베팅을 시작하세요`;broadcast();
}

io.on('connection',socket=>{
 socket.on('takeSeat',({seat,name,token})=>{
   if(clearStaleWaitingSeats()) updateWaitingStatus();
   seat=Number(seat);name=String(name||'').trim().slice(0,12);token=String(token||'');
   socket.data.token=token;
   if(!token||seat<0||seat>9)return socket.emit('seatError','잘못된 좌석 요청입니다.');
   if(!name)return socket.emit('seatError','닉네임을 입력해주세요.');

   const existing=byToken(token);

   if(existing>=0){
     const p=G.players[existing];
     if(G.gameStarted){
       socket.emit('seatOk',{seat:existing});
       return broadcast();
     }

     const duplicated=G.players.some((x,idx)=>x&&idx!==existing&&x.name.toLowerCase()===name.toLowerCase());
     if(duplicated)return socket.emit('seatError','이미 사용 중인 닉네임입니다.');

     if(seat!==existing){
       if(p.confirmed)return socket.emit('seatError','베팅 완료 후에는 자리를 이동할 수 없습니다.');
       if(G.players[seat])return socket.emit('seatError','이미 사용 중인 좌석입니다.');
       G.players[seat]=p;
       G.players[existing]=null;
     }

     G.players[seat].name=name;
     G.players[seat].socketId=socket.id;
     G.players[seat].connected=true;
     G.players[seat].disconnectedAt=null;
     socket.emit('seatOk',{seat});
     updateWaitingStatus();
     broadcast();
     return;
   }

   if(G.gameStarted)return socket.emit('seatError','게임 시작 후에는 중간 착석이 불가합니다.');
   if(G.players[seat])return socket.emit('seatError','이미 사용 중인 좌석입니다.');
   if(G.players.some(p=>p&&p.name.toLowerCase()===name.toLowerCase()))return socket.emit('seatError','이미 사용 중인 닉네임입니다.');

   G.players[seat]={token,socketId:socket.id,connected:true,disconnectedAt:null,name,bank:START,bet:{main:0,pair:0,trio:0},betLast:{main:0,pair:0,trio:0},history:[],confirmed:false,hands:[],roundResult:''};
   socket.emit('seatOk',{seat});
   updateWaitingStatus();
   broadcast();
 });
 socket.on('leaveSeat',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i<0)return socket.emit('seatLeft');
   const p=G.players[i];
   if(G.gameStarted)return socket.emit('seatError','게임 진행 중에는 자리를 비울 수 없습니다.');
   if(p.confirmed)return socket.emit('seatError','베팅 완료 후에는 자리를 비울 수 없습니다.');
   G.players[i]=null;
   socket.emit('seatLeft');
   updateWaitingStatus();
   broadcast();
 });
 socket.on('hello',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i>=0){
     G.players[i].socketId=socket.id;
     G.players[i].connected=true;
     G.players[i].disconnectedAt=null;
   }
   broadcast();
 });
 socket.on('betAdd',({token,mode,value})=>{
   socket.data.token=String(token||'');const i=byToken(socket.data.token),p=G.players[i];value=Number(value);
   if(!p)return socket.emit('actionError','내 좌석이 없습니다.');
   if(G.gameStarted||p.confirmed)return;
   if(!['main','pair','trio'].includes(mode)||![10000,50000,100000,200000,500000].includes(value))return;
   const total=p.bet.main+p.bet.pair+p.bet.trio;if(total+value>p.bank)return socket.emit('actionError','보유금보다 많이 베팅할 수 없습니다.');
   p.bet[mode]+=value;p.betLast[mode]=value;p.history.push({mode,v:value});broadcast();
 });
 socket.on('betUndo',({token})=>{const i=byToken(String(token||'')),p=G.players[i];if(!p||G.gameStarted||p.confirmed)return;const h=p.history.pop();if(h){p.bet[h.mode]=Math.max(0,p.bet[h.mode]-h.v);const prev=[...p.history].reverse().find(x=>x.mode===h.mode);p.betLast[h.mode]=prev?prev.v:0}broadcast()});
 socket.on('betClear',({token})=>{const i=byToken(String(token||'')),p=G.players[i];if(!p||G.gameStarted||p.confirmed)return;p.bet={main:0,pair:0,trio:0};p.betLast={main:0,pair:0,trio:0};p.history=[];broadcast()});
 socket.on('betConfirm',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];if(!p||G.gameStarted||p.confirmed)return;
   const total=p.bet.main+p.bet.pair+p.bet.trio;if(total<=0)return socket.emit('actionError','베팅 금액을 먼저 선택하세요.');if(total>p.bank)return socket.emit('actionError','보유금이 부족합니다.');
   p.bank-=total;p.confirmed=true;updateWaitingStatus();broadcast();maybeStart();
 });
 socket.on('turnAction',({token,action})=>{
   const i=byToken(String(token||'')),[seat,p,h]=current();if(i<0||i!==seat||!p||!h||h.state!=='PLAY'||G.dealing||G.settling)return;
   if(action==='hit'){
     h.cards.push(G.deck.pop());const v=handValue(h.cards);if(v>21){h.state='BUST';h.result='BUST';G.status=`${p.name} BUST · 다음 플레이어`;G.activeHandIndex++;broadcast();return setTimeout(advanceTurn,450)}
     if(v===21){h.state='STAND';G.activeHandIndex++;broadcast();return setTimeout(advanceTurn,350)}
     G.status=`${p.name} 차례 · 현재 ${v}`;broadcast();
   }else if(action==='stand'){h.state='STAND';G.activeHandIndex++;broadcast();setTimeout(advanceTurn,200)}
   else if(action==='double'){
     if(!canDouble(p,h))return;p.bank-=h.bet;h.bet*=2;h.doubled=true;h.cards.push(G.deck.pop());const v=handValue(h.cards);if(v>21){h.state='BUST';h.result='BUST'}else h.state='STAND';G.activeHandIndex++;broadcast();setTimeout(advanceTurn,360)
   }else if(action==='split'){
     if(!canSplit(p,h))return;p.bank-=h.bet;const [c1,c2]=h.cards,bet=h.bet;
     const h1={cards:[c1,G.deck.pop()],bet,state:'PLAY',doubled:false,split:true,result:''},h2={cards:[c2,G.deck.pop()],bet,state:'PLAY',doubled:false,split:true,result:''};
     for(const x of [h1,h2]){const v=handValue(x.cards);if(v>21){x.state='BUST';x.result='BUST'}else if(v===21)x.state='STAND'}
     p.hands.splice(G.activeHandIndex,1,h1,h2);broadcast();if(p.hands[G.activeHandIndex].state!=='PLAY'){G.activeHandIndex++;setTimeout(advanceTurn,220)}
   }
 });
 socket.on('disconnect',()=>{
   const i=G.players.findIndex(p=>p&&p.socketId===socket.id);
   if(i>=0){
     const p=G.players[i];
     const token=p.token;
     p.connected=false;
     p.disconnectedAt=Date.now();
     p.socketId=null;
     broadcast();

     setTimeout(()=>{
       const idx=byToken(token);
       if(idx<0)return;
       const current=G.players[idx];
       const reconnected=[...io.sockets.sockets.values()].some(s=>s.data.token===token);
       if(reconnected){
         current.connected=true;
         current.disconnectedAt=null;
         return;
       }
       if(!G.gameStarted){
         G.players[idx]=null;
         updateWaitingStatus();
         broadcast();
       }
     },20000);
   }
 });
 setTimeout(()=>socket.emit('state',snapshotFor(socket)),50);
});

server.listen(PORT,'0.0.0.0',()=>console.log(`BLACKJACK BASAN multiplayer on ${PORT}`));
