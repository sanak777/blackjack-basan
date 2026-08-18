const express=require('express');
const http=require('http');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{pingInterval:12000,pingTimeout:25000});
const PORT=process.env.PORT||3000;
const ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||'9981');
const START=1000000;
const WIN_TARGET=10000000;
const MIN_BET=10000;
const BET_SECONDS=15;
const INSURANCE_SECONDS=10;

app.use(express.static(__dirname));
app.get('/health',(req,res)=>res.json({ok:true,version:'V33_ADMIN_STABLE'}));

const G={
 players:Array(10).fill(null),
 eliminatedSeats:Array(10).fill(null),
 gameStarted:false,dealing:false,settling:false,
 tournamentStarted:false,tournamentOver:false,winnerName:'',
 roundNo:1,dealerHand:[],deck:[],turnOrder:[],turnIndex:0,activeHandIndex:0,
 status:'10명 모이면 시작합니다 · 0 / 10',
 countdown:null,betTimer:null,turnTimer:null,insuranceTimer:null,hideHole:false,
 insuranceOpen:false,insuranceDeadline:null
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const moneySafe=n=>'₩'+Math.round(Number(n||0)).toLocaleString('ko-KR');
function makeDeck(){
 const suits=['♠','♥','♦','♣'],ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],d=[];
 for(let k=0;k<6;k++)for(const s of suits)for(const r of ranks)d.push({s,r});
 for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}
 return d;
}
function handValue(cards){
 let t=0,a=0;
 for(const c of cards||[]){
   if(c.r==='A'){t+=11;a++}
   else if(['K','Q','J'].includes(c.r))t+=10;
   else t+=Number(c.r)
 }
 while(t>21&&a){t-=10;a--}
 return t;
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
function aliveEntries(){return G.players.map((p,i)=>p?{p,i}:null).filter(Boolean)}
function alivePlayers(){return G.players.filter(Boolean)}
function clearCountdown(){
 if(G.countdown){clearInterval(G.countdown);G.countdown=null}
}
function stopBetTimer(){
 if(G.betTimer){clearInterval(G.betTimer);G.betTimer=null}
}
function stopTurnTimer(){
 if(G.turnTimer){clearTimeout(G.turnTimer);G.turnTimer=null}
}
function stopInsuranceTimer(){
 if(G.insuranceTimer){clearInterval(G.insuranceTimer);G.insuranceTimer=null}
 G.insuranceDeadline=null;
}
function reserveEliminatedSeat(i,p,reason='탈락'){
 if(i<0||i>9)return;
 G.eliminatedSeats[i]={
   name:p?.name||`SEAT ${i+1}`,
   reason,
   bank:Number(p?.bank||0)
 };
}
function clearStaleWaitingSeats(){
 if(G.gameStarted)return false;
 const now=Date.now();let changed=false;
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];
   if(!p||p.connected!==false||!p.disconnectedAt)continue;
   const grace=p.confirmed?30000:15000;
   if(now-p.disconnectedAt>=grace){
     G.players[i]=null;changed=true;
   }
 }
 return changed;
}
function publicPlayer(p){
 if(!p)return null;
 const {token,socketId,...q}=p;
 return q;
}
function snapshotFor(socket){
 const mySeat=byToken(socket.data.token);
 let turnSeat=G.turnIndex<G.turnOrder.length?G.turnOrder[G.turnIndex]:null;
 let p=turnSeat!==null?G.players[turnSeat]:null,h=p&&p.hands?p.hands[G.activeHandIndex]:null;
 return {
   players:G.players.map(publicPlayer),
   eliminatedSeats:G.eliminatedSeats,
   dealerHand:G.dealerHand.map((c,i)=>i===1&&G.hideHole?{hidden:true}:c),
   hideHole:G.hideHole,gameStarted:G.gameStarted,dealing:G.dealing,settling:G.settling,
   tournamentStarted:G.tournamentStarted,tournamentOver:G.tournamentOver,winnerName:G.winnerName,
   roundNo:G.roundNo,status:G.status,turnSeat,activeHandIndex:G.activeHandIndex,
   canSplit:turnSeat===mySeat&&canSplit(p,h),canDouble:turnSeat===mySeat&&canDouble(p,h),
   insuranceOpen:G.insuranceOpen,
   insuranceDeadline:G.insuranceDeadline,
   insuranceSeconds:INSURANCE_SECONDS,
   mySeat,serverNow:Date.now(),betSeconds:BET_SECONDS
 };
}
function broadcast(){
 for(const s of io.sockets.sockets.values())s.emit('state',snapshotFor(s));
}
function remainingBetSeconds(){
 const pending=alivePlayers().filter(p=>!p.confirmed&&p.betDeadline);
 if(!pending.length)return 0;
 return Math.max(0,Math.ceil(Math.max(...pending.map(p=>p.betDeadline))-Date.now())/1000);
}
function updateWaitingStatus(){
 if(G.tournamentOver){
   G.status=`🏆 ${G.winnerName} 최종 우승 · TOURNAMENT COMPLETE`;
   return;
 }
 if(G.gameStarted)return;
 const alive=alivePlayers();
 const done=alive.filter(p=>p.confirmed).length;
 const remain=remainingBetSeconds();
 if(!G.tournamentStarted){
   G.status=`방장 게임 시작 대기 · ${alive.length} / 10`;
 }else{
   G.status=`생존 ${alive.length}명 · 베팅 완료 ${done} / ${alive.length}${remain?` · ${remain}초`:''}`;
 }
}
function finishTournament(entry){
 stopBetTimer();stopTurnTimer();clearCountdown();
 G.gameStarted=false;G.dealing=false;G.settling=false;G.tournamentOver=true;G.tournamentStarted=true;
 G.winnerName=entry?.p?.name||'WINNER';
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];
   if(!p)continue;
   if(i!==entry?.i){
     reserveEliminatedSeat(i,p,p.eliminatedPending?'BUST 탈락':'탈락');
     G.players[i]=null;
   }else{
     G.players[i].confirmed=true;
     G.players[i].betDeadline=null;
     G.players[i].lastAction='CHAMPION';
     G.players[i].roundResult='🏆 FINAL WINNER';
   }
 }
 updateWaitingStatus();broadcast();
}
function checkFinalWinner(){
 const alive=aliveEntries();
 if(G.tournamentStarted&&alive.length===1){finishTournament(alive[0]);return true}
 return false;
}

function checkTargetWinner(){
 if(!G.tournamentStarted||G.tournamentOver)return false;
 const alive=aliveEntries();
 if(!alive.some(({p})=>Number(p.bank||0)>=WIN_TARGET))return false;

 // 목표금액 이상이 여러 명이어도 현재 보유금이 가장 높은 1명이 우승.
 // 완전히 같은 금액이면 좌석 번호가 빠른 사람을 안정적인 타이브레이커로 사용.
 const winner=[...alive].sort((a,b)=>Number(b.p.bank||0)-Number(a.p.bank||0)||a.i-b.i)[0];
 if(!winner||Number(winner.p.bank||0)<WIN_TARGET)return false;

 G.status=`🏆 ${winner.p.name} ${moneySafe(winner.p.bank)} · 목표 ${moneySafe(WIN_TARGET)} 달성 · 최종 우승`;
 finishTournament(winner);
 return true;
}

function resetTournament(){
 stopBetTimer();stopTurnTimer();stopInsuranceTimer();clearCountdown();

 G.players=Array(10).fill(null);
 G.eliminatedSeats=Array(10).fill(null);
 G.gameStarted=false;
 G.dealing=false;
 G.settling=false;
 G.tournamentStarted=false;
 G.tournamentOver=false;
 G.winnerName='';
 G.roundNo=1;
 G.dealerHand=[];
 G.deck=[];
 G.turnOrder=[];
 G.turnIndex=0;
 G.activeHandIndex=0;
 G.status='방장 게임 시작 대기 · 0 / 10';
 G.countdown=null;
 G.betTimer=null;
 G.turnTimer=null;
 G.insuranceTimer=null;
 G.hideHole=false;
 G.insuranceOpen=false;
 G.insuranceDeadline=null;

 // 연결 자체는 유지하되, 모든 참가자의 좌석/대회 상태를 완전히 초기화
 for(const s of io.sockets.sockets.values())s.data.token='';
 broadcast();
 io.emit('tournamentReset');
}


function adminStartGame(){
 if(G.tournamentOver)return {ok:false,msg:'우승 처리 후 게임판 종료/초기화를 먼저 해주세요.'};
 if(G.tournamentStarted||G.gameStarted)return {ok:false,msg:'이미 게임이 진행 중입니다.'};
 const alive=alivePlayers();
 if(alive.length<1)return {ok:false,msg:'참가자가 1명 이상 착석해야 시작할 수 있습니다.'};

 G.tournamentStarted=true;
 G.gameStarted=false;
 G.status=`방장 START · 참가자 ${alive.length}명 · 개인 베팅 15초`;
 for(const p of alive){
   p.confirmed=false;
   p.autoConfirmed=false;
   p.betDeadline=null;
   p.betState=(p.bet.main+p.bet.pair+p.bet.trio)>0?'BETTING':'WAITING_BET';
 }
 broadcast();
 armBettingClock();
 return {ok:true};
}

function adminStopGame(){
 resetTournament();
 G.status='방장이 게임판을 종료했습니다 · 새 참가자 착석 대기';
 broadcast();
 io.emit('adminGameStopped');
 return {ok:true};
}

function confirmPlayerBet(p,auto=false){
 if(!p||p.confirmed)return false;
 let total=p.bet.main+p.bet.pair+p.bet.trio;
 if(total<=0){
   if(p.bank<MIN_BET)return false;
   p.bet.main=MIN_BET;p.betLast.main=MIN_BET;p.history.push({mode:'main',v:MIN_BET});total=MIN_BET;
 }
 if(total>p.bank)return false;
 p.bank-=total;p.confirmed=true;p.autoConfirmed=!!auto;p.betDeadline=null;
 p.betState=auto?'AUTO_CONFIRMED':'CONFIRMED';
 return true;
}
function armBettingClock(){
 if(G.tournamentOver||G.gameStarted)return;
 const alive=alivePlayers();
 if(!G.tournamentStarted){
   stopBetTimer();
   for(const p of alive)if(!p.confirmed)p.betDeadline=null;
   G.status=`방장 게임 시작 대기 · ${alive.length} / 10`;
   broadcast();return;
 }
 if(G.tournamentStarted&&alive.length<=1){
   checkFinalWinner();return;
 }
 const now=Date.now();
 for(const p of alive){
   if(!p.confirmed&&!p.betDeadline){
     p.betDeadline=now+BET_SECONDS*1000;
     p.autoConfirmed=false;
     p.betState=(p.bet.main+p.bet.pair+p.bet.trio)>0?'BETTING':'WAITING_BET';
   }
 }
 stopBetTimer();
 G.betTimer=setInterval(()=>{
   if(G.gameStarted||G.tournamentOver){stopBetTimer();return}
   const now2=Date.now();
   let changed=false;
   for(let i=0;i<G.players.length;i++){
     const p=G.players[i];if(!p||p.confirmed||!p.betDeadline)continue;
     if(now2>=p.betDeadline){
       if(confirmPlayerBet(p,true)){changed=true}
       else{
         // 최소 베팅도 불가능하면 토너먼트에서는 탈락 처리.
         if(G.tournamentStarted){
           p.roundResult='잔액 부족 탈락';
           G.players[i]=null;
           changed=true;
         }else{
           p.betDeadline=now2+BET_SECONDS*1000;
         }
       }
     }
   }
   if(checkFinalWinner())return;
   updateWaitingStatus();broadcast();
   maybeStart();
 },500);
 updateWaitingStatus();broadcast();maybeStart();
}
function maybeStart(){
 if(G.gameStarted||G.tournamentOver||G.countdown)return;
 const alive=alivePlayers();
 if(!G.tournamentStarted)return;
 if(alive.length<2){checkFinalWinner();return}
 if(!alive.length||!alive.every(p=>p.confirmed))return;

 stopBetTimer();
 let n=3;
 G.status=`전원 베팅 완료 · ${n}초 후 패 배분`;broadcast();
 G.countdown=setInterval(()=>{
   n--;
   if(n<=0){
     clearCountdown();
     startRound();
   }else{
     G.status=`전원 베팅 완료 · ${n}초 후 패 배분`;broadcast();
   }
 },1000);
}
async function startRound(){
 const alive=alivePlayers();
 if(!G.tournamentStarted||alive.length<1)return;
 G.tournamentStarted=true;
 G.gameStarted=true;G.dealing=true;G.settling=false;G.deck=makeDeck();G.dealerHand=[];
 G.turnOrder=[];G.turnIndex=0;G.activeHandIndex=0;G.hideHole=false;

 G.players.forEach((p,i)=>{
   if(!p||!p.confirmed)return;
   p.hands=[{cards:[],bet:p.bet.main,state:'PLAY',doubled:false,split:false,result:''}];
   p.initialCards=[];p.inRound=true;p.roundResult='';p.sideResult='';
   p.lastAction='WAIT';p.eliminatedPending=false;p.betDeadline=null;
   p.insuranceBet=0;p.insuranceDecision=null;
   G.turnOrder.push(i);
 });
 G.status=`ROUND ${G.roundNo} · 생존 ${G.turnOrder.length}명 · 딜러 오픈카드`;
 G.dealerHand.push(G.deck.pop());broadcast();await sleep(500);
 for(const i of G.turnOrder){
   if(!G.players[i])continue;
   G.status=`ROUND ${G.roundNo} · ${G.players[i].name} 첫 번째 카드`;
   G.players[i].hands[0].cards.push(G.deck.pop());broadcast();await sleep(330)
 }
 G.status=`ROUND ${G.roundNo} · 딜러 비하인드 카드`;
 G.dealerHand.push(G.deck.pop());G.hideHole=true;broadcast();await sleep(500);
 for(const i of G.turnOrder){
   const p=G.players[i];if(!p)continue;
   const h=p.hands[0];
   G.status=`ROUND ${G.roundNo} · ${p.name} 두 번째 카드`;
   h.cards.push(G.deck.pop());p.initialCards=h.cards.map(c=>({...c}));
   if(handValue(h.cards)===21){h.state='STAND';p.lastAction='BLACKJACK'}
   broadcast();await sleep(330);
 }
 G.dealing=false;
 if(G.dealerHand[0]?.r==='A'){
   openInsurance();
 }else{
   G.status='딜링 완료 · 플레이 시작';broadcast();await sleep(350);advanceTurn();
 }
}

function openInsurance(){
 stopInsuranceTimer();
 G.insuranceOpen=true;
 G.insuranceDeadline=Date.now()+INSURANCE_SECONDS*1000;
 for(const i of G.turnOrder){
   const p=G.players[i];
   if(!p)continue;
   p.insuranceBet=0;
   p.insuranceDecision=null;
 }
 G.status=`딜러 오픈 A · INSURANCE 선택 ${INSURANCE_SECONDS}초`;
 broadcast();
 G.insuranceTimer=setInterval(()=>{
   if(!G.insuranceOpen){stopInsuranceTimer();return}
   if(Date.now()>=G.insuranceDeadline){
     for(const i of G.turnOrder){
       const p=G.players[i];
       if(p&&p.insuranceDecision===null)p.insuranceDecision=false;
     }
     finishInsuranceChoices();
   }
 },250);
}
function allInsuranceDecided(){
 return G.turnOrder.every(i=>{
   const p=G.players[i];
   return !p||p.insuranceDecision!==null;
 });
}
function finishInsuranceChoices(){
 if(!G.insuranceOpen||!allInsuranceDecided())return;
 stopInsuranceTimer();
 G.insuranceOpen=false;
 const dealerBJ=G.dealerHand.length===2&&handValue(G.dealerHand)===21;
 if(dealerBJ){
   G.status='딜러 BLACKJACK · 보험 정산';
   G.hideHole=false;
   broadcast();
   setTimeout(settle,700);
 }else{
   G.status='딜러 BLACKJACK 아님 · 플레이 시작';
   broadcast();
   setTimeout(advanceTurn,500);
 }
}

function current(){
 if(G.turnIndex>=G.turnOrder.length)return[null,null,null];
 const seat=G.turnOrder[G.turnIndex],p=G.players[seat],h=p?.hands?.[G.activeHandIndex];
 return[seat,p,h];
}
function advanceTurn(){
 stopTurnTimer();
 while(G.turnIndex<G.turnOrder.length){
   const p=G.players[G.turnOrder[G.turnIndex]];
   if(!p){G.turnIndex++;G.activeHandIndex=0;continue}
   while(G.activeHandIndex<p.hands.length&&p.hands[G.activeHandIndex].state!=='PLAY')G.activeHandIndex++;
   if(G.activeHandIndex<p.hands.length)break;
   G.turnIndex++;G.activeHandIndex=0;
 }
 if(G.turnIndex>=G.turnOrder.length){
   G.status='모든 플레이어 액션 완료 · 딜러 비하인드 오픈';broadcast();revealDealer();return
 }

 const [seat,p,h]=current();
 p.lastAction='TURN';

 const disconnected=p.connected===false;
 G.status=disconnected
   ? `${p.name} 연결 끊김 · 행동시간 10초`
   : `${p.name} 차례 · 행동시간 10초 · HIT / STAND / DOUBLE / SPLIT`;
 broadcast();

 G.turnTimer=setTimeout(()=>{
   const [seat2,p2,h2]=current();
   if(seat2!==seat||!p2||!h2||h2.state!=='PLAY')return;

   p2.inactiveTurns=(p2.inactiveTurns||0)+1;

   if(p2.inactiveTurns>=3){
     h2.state='BUST';
     p2.eliminatedPending=true;
     p2.lastAction='AUTO OUT';
     p2.roundResult='3턴 연속 무응답 · 자동 탈락';
     reserveEliminatedSeat(seat2,p2,'3턴 무응답 자동 탈락');
     G.players[seat2]=null;
     G.status=`${p2.name} · 3턴 연속 무응답으로 자동 탈락`;
     G.turnIndex++;
     G.activeHandIndex=0;
     broadcast();
     setTimeout(advanceTurn,250);
     return;
   }

   h2.state='STAND';
   p2.lastAction=`AUTO STAND ${p2.inactiveTurns}/3`;
   G.activeHandIndex++;
   G.status=`${p2.name} 무응답 ${p2.inactiveTurns}/3 · 자동 STAND`;
   broadcast();
   setTimeout(advanceTurn,250);
 },10000);
}
async function revealDealer(){
 G.settling=true;G.hideHole=false;G.status='딜러 비하인드 카드 오픈';broadcast();await sleep(650);
 while(handValue(G.dealerHand)<17){
   G.status=`딜러 ${handValue(G.dealerHand)} · HIT`;
   G.dealerHand.push(G.deck.pop());broadcast();await sleep(600)
 }
 G.status=`딜러 ${handValue(G.dealerHand)} · 정산`;broadcast();await sleep(500);settle();
}
function settle(){
 const dv=handValue(G.dealerHand),db=dv>21,dbj=G.dealerHand.length===2&&dv===21;
 for(const p of G.players){
   if(!p||!p.inRound)continue;
   const texts=[];
   if((p.insuranceBet||0)>0){
     if(dbj){
       p.bank+=p.insuranceBet*3;
       texts.push(`INSURANCE WIN ${moneySafe(p.insuranceBet*2)}`);
     }else{
       texts.push('INSURANCE LOSE');
     }
   }
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
   if(p.bet.pair>0){
     const o=pairOdds(p.initialCards);
     if(o){p.bank+=p.bet.pair*(o+1);texts.push(`PP ${o}:1`)}else texts.push('PP LOSE')
   }
   if(p.bet.trio>0){
     const o=trioOdds(p.initialCards,G.dealerHand[0]);
     if(o){p.bank+=p.bet.trio*(o+1);texts.push(`21+3 ${o}:1`)}else texts.push('21+3 LOSE')
   }
   const allBust=p.hands.length>0&&p.hands.every(h=>h.state==='BUST'||handValue(h.cards)>21);
   if(allBust){
     p.lastAction='BUST';
     texts.push(p.bank>=MIN_BET?'BUST · 생존':'BUST · 잔액 소진');
   }else if(p.lastAction==='TURN'||p.lastAction==='WAIT'){
     p.lastAction='ROUND DONE';
   }
   p.roundResult=texts.join(' · ');
 }
 G.settling=false;

 // 정산이 모두 끝난 시점의 실제 보유금으로 목표 우승 판정.
 // 10,000,000원 이상이 여러 명이면 그중(=전체 생존자 중) 보유금 최고액 1명이 즉시 우승.
 if(checkTargetWinner())return;

 const brokeCount=alivePlayers().filter(p=>p.bank<MIN_BET).length;
 G.status=`ROUND ${G.roundNo} 정산 완료${brokeCount?` · 잔액 부족 탈락 예정 ${brokeCount}명`:''} · 다음 라운드 준비`;
 broadcast();setTimeout(nextRound,4200);
}
function nextRound(){
 stopTurnTimer();stopInsuranceTimer();
 G.insuranceOpen=false;
 G.gameStarted=false;G.dealing=false;G.settling=false;G.dealerHand=[];G.hideHole=false;
 G.turnOrder=[];G.turnIndex=0;G.activeHandIndex=0;G.roundNo++;

 const before=aliveEntries();
 for(const {p} of before){
   if((p.inactiveTurns||0)>=3){
     p.eliminatedPending=true;
     p.roundResult='3턴 연속 무응답 · 자동 탈락';
   }
 }
 const survivors=before.filter(({p})=>!p.eliminatedPending&&p.bank>=MIN_BET);

 if(survivors.length===0&&before.length){
   const fallback=[...before].sort((a,b)=>b.p.bank-a.p.bank||a.i-b.i)[0];
   return finishTournament(fallback);
 }
 if(survivors.length===1){
   for(const {i,p} of before){
     if(i!==survivors[0].i){
       reserveEliminatedSeat(i,p,p.eliminatedPending?'자동 탈락':'잔액 부족 탈락');
       G.players[i]=null;
     }
   }
   return finishTournament(survivors[0]);
 }

 const survivorSeats=new Set(survivors.map(x=>x.i));
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];if(!p)continue;
   if(!survivorSeats.has(i)){
     reserveEliminatedSeat(i,p,p.eliminatedPending?'자동 탈락':'잔액 부족 탈락');
     G.players[i]=null;
     continue;
   }
   p.hands=[];p.initialCards=[];p.inRound=false;
   p.bet={main:0,pair:0,trio:0};p.betLast={main:0,pair:0,trio:0};p.history=[];
   p.confirmed=false;p.autoConfirmed=false;p.betDeadline=null;p.betState='WAITING_BET';
   p.roundResult='';p.lastAction='WAIT';p.eliminatedPending=false;
   p.insuranceBet=0;p.insuranceDecision=null;
 }
 updateWaitingStatus();broadcast();
 armBettingClock();
}

io.on('connection',socket=>{
 socket.on('takeSeat',({seat,name,token})=>{
   if(clearStaleWaitingSeats())updateWaitingStatus();
   seat=Number(seat);name=String(name||'').trim().slice(0,12);token=String(token||'');
   socket.data.token=token;
   if(!token||seat<0||seat>9)return socket.emit('seatError','잘못된 좌석 요청입니다.');
   if(!name)return socket.emit('seatError','닉네임을 입력해주세요.');

   const existing=byToken(token);
   if(existing>=0){
     const p=G.players[existing];
     if(G.gameStarted||G.tournamentStarted){
       socket.emit('seatOk',{seat:existing});return broadcast();
     }
     const duplicated=G.players.some((x,idx)=>x&&idx!==existing&&x.name.toLowerCase()===name.toLowerCase());
     if(duplicated)return socket.emit('seatError','이미 사용 중인 닉네임입니다.');
     if(seat!==existing){
       if(p.confirmed)return socket.emit('seatError','베팅 완료 후에는 자리를 이동할 수 없습니다.');
       if(G.players[seat])return socket.emit('seatError','이미 사용 중인 좌석입니다.');
       G.players[seat]=p;G.players[existing]=null;
     }
     G.players[seat].name=name;G.players[seat].socketId=socket.id;
     G.players[seat].connected=true;G.players[seat].disconnectedAt=null;
     socket.emit('seatOk',{seat});updateWaitingStatus();broadcast();armBettingClock();return;
   }

   if(G.tournamentStarted||G.gameStarted)return socket.emit('seatError','대회 시작 후에는 중간 참가가 불가합니다.');
   if(G.eliminatedSeats[seat])return socket.emit('seatError','탈락 자리입니다. 중도 참가할 수 없습니다.');
   if(G.players[seat])return socket.emit('seatError','이미 사용 중인 좌석입니다.');
   if(G.players.some(p=>p&&p.name.toLowerCase()===name.toLowerCase()))return socket.emit('seatError','이미 사용 중인 닉네임입니다.');

   G.players[seat]={
     token,socketId:socket.id,connected:true,disconnectedAt:null,inactiveTurns:0,name,bank:START,
     bet:{main:0,pair:0,trio:0},betLast:{main:0,pair:0,trio:0},history:[],
     confirmed:false,autoConfirmed:false,betDeadline:null,betState:'WAITING_BET',
     hands:[],roundResult:'',lastAction:'WAIT',eliminatedPending:false,insuranceBet:0,insuranceDecision:null
   };
   socket.emit('seatOk',{seat});updateWaitingStatus();broadcast();armBettingClock();
 });
 socket.on('leaveSeat',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i<0)return socket.emit('seatLeft');
   const p=G.players[i];
   if(G.tournamentStarted)return socket.emit('seatError','대회 진행 중에는 자리를 비울 수 없습니다.');
   if(p.confirmed)return socket.emit('seatError','베팅 완료 후에는 자리를 비울 수 없습니다.');
   G.players[i]=null;socket.emit('seatLeft');updateWaitingStatus();broadcast();armBettingClock();
 });
 socket.on('hello',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i>=0){
     G.players[i].socketId=socket.id;G.players[i].connected=true;G.players[i].disconnectedAt=null;
   }
   broadcast();
 });
 socket.on('betAdd',({token,mode,value})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token),p=G.players[i];value=Number(value);
   if(!p)return socket.emit('actionError','내 좌석이 없습니다.');
   if(G.gameStarted||G.tournamentOver||p.confirmed)return;
   if(!G.tournamentStarted&&alivePlayers().length<10){
     // 10명 전에도 베팅 금액은 미리 올려둘 수 있습니다.
   }
   if(!['main','pair','trio'].includes(mode)||![10000,50000,100000,200000,500000].includes(value))return;
   const total=p.bet.main+p.bet.pair+p.bet.trio;
   if(total+value>p.bank)return socket.emit('actionError','보유금보다 많이 베팅할 수 없습니다.');
   p.bet[mode]+=value;p.betLast[mode]=value;p.history.push({mode,v:value});
   p.betState='BETTING';broadcast();
 });
 socket.on('betUndo',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p||G.gameStarted||G.tournamentOver||p.confirmed)return;
   const h=p.history.pop();
   if(h){
     p.bet[h.mode]=Math.max(0,p.bet[h.mode]-h.v);
     const prev=[...p.history].reverse().find(x=>x.mode===h.mode);
     p.betLast[h.mode]=prev?prev.v:0;
   }
   p.betState=(p.bet.main+p.bet.pair+p.bet.trio)>0?'BETTING':'WAITING_BET';broadcast();
 });
 socket.on('betClear',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p||G.gameStarted||G.tournamentOver||p.confirmed)return;
   p.bet={main:0,pair:0,trio:0};p.betLast={main:0,pair:0,trio:0};p.history=[];p.betState='WAITING_BET';broadcast();
 });
 socket.on('betConfirm',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p||G.gameStarted||G.tournamentOver||p.confirmed)return;
   const total=p.bet.main+p.bet.pair+p.bet.trio;
   if(total<=0)return socket.emit('actionError','베팅 금액을 먼저 선택하세요.');
   if(total>p.bank)return socket.emit('actionError','보유금이 부족합니다.');
   confirmPlayerBet(p,false);
   updateWaitingStatus();broadcast();
   if(!G.tournamentStarted&&alivePlayers().length===10)armBettingClock();
   maybeStart();
 });
 socket.on('insuranceChoice',({token,take})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!G.insuranceOpen||!p||!p.inRound||p.insuranceDecision!==null)return;
   const amount=Math.floor((p.bet.main||0)/2);
   if(take){
     if(amount<=0)return socket.emit('actionError','MAIN 베팅이 없어 인슈어런스를 선택할 수 없습니다.');
     if(p.bank<amount)return socket.emit('actionError','인슈어런스 베팅에 필요한 보유금이 부족합니다.');
     p.bank-=amount;
     p.insuranceBet=amount;
     p.insuranceDecision=true;
     p.lastAction='INSURANCE';
   }else{
     p.insuranceBet=0;
     p.insuranceDecision=false;
     p.lastAction='NO INSURANCE';
   }
   broadcast();
   if(allInsuranceDecided())finishInsuranceChoices();
 });
 socket.on('turnAction',({token,action})=>{
   const i=byToken(String(token||'')),[seat,p,h]=current();
   if(i<0||i!==seat||!p||!h||h.state!=='PLAY'||G.dealing||G.settling||G.insuranceOpen)return;
   stopTurnTimer();
   p.inactiveTurns=0;

   if(action==='hit'){
     p.lastAction='HIT';
     h.cards.push(G.deck.pop());
     const v=handValue(h.cards);
     if(v>21){
       h.state='BUST';h.result='BUST';
       const allDoneBust=p.hands.every(x=>x.state==='BUST');
       p.lastAction=allDoneBust?'BUST':'HIT · BUST';
       G.status=`${p.name} BUST · 다음 플레이어`;
       G.activeHandIndex++;broadcast();return setTimeout(advanceTurn,450)
     }
     if(v===21){
       h.state='STAND';p.lastAction='STAND · 21';
       G.activeHandIndex++;broadcast();return setTimeout(advanceTurn,350)
     }
     G.status=`${p.name} HIT · 현재 ${v}`;broadcast();
   }else if(action==='stand'){
     h.state='STAND';p.lastAction='STAND';
     G.activeHandIndex++;G.status=`${p.name} STAND 완료`;broadcast();setTimeout(advanceTurn,200);
   }else if(action==='double'){
     if(!canDouble(p,h))return;
     p.bank-=h.bet;h.bet*=2;h.doubled=true;h.cards.push(G.deck.pop());
     const v=handValue(h.cards);
     if(v>21){h.state='BUST';h.result='BUST';p.lastAction='DOUBLE · BUST'}
     else{h.state='STAND';p.lastAction='DOUBLE · STAND'}
     G.activeHandIndex++;broadcast();setTimeout(advanceTurn,360);
   }else if(action==='split'){
     if(!canSplit(p,h))return;
     p.lastAction='SPLIT';
     p.bank-=h.bet;const [c1,c2]=h.cards,bet=h.bet;
     const h1={cards:[c1,G.deck.pop()],bet,state:'PLAY',doubled:false,split:true,result:''};
     const h2={cards:[c2,G.deck.pop()],bet,state:'PLAY',doubled:false,split:true,result:''};
     for(const x of [h1,h2]){
       const v=handValue(x.cards);
       if(v>21){x.state='BUST';x.result='BUST'}
       else if(v===21)x.state='STAND'
     }
     p.hands.splice(G.activeHandIndex,1,h1,h2);broadcast();
     if(p.hands[G.activeHandIndex].state!=='PLAY'){G.activeHandIndex++;setTimeout(advanceTurn,220)}
   }
 });
 socket.on('resetTournament',({token})=>{
   socket.data.token=String(token||'');
   if(!G.tournamentOver)return socket.emit('actionError','대회 종료 후에만 리셋할 수 있습니다.');
   resetTournament();
 });

 socket.on('adminLogin',({password})=>{
   if(String(password||'')!==ADMIN_PASSWORD){
     return socket.emit('adminLoginResult',{ok:false,msg:'비밀번호가 틀렸습니다.'});
   }
   socket.data.isAdmin=true;
   socket.emit('adminLoginResult',{ok:true});
 });

 socket.on('adminStartGame',()=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   const r=adminStartGame();
   if(!r.ok)socket.emit('actionError',r.msg);
 });

 socket.on('adminStopGame',()=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   adminStopGame();
 });
 socket.on('disconnect',()=>{
   const i=G.players.findIndex(p=>p&&p.socketId===socket.id);
   if(i>=0){
     const p=G.players[i],token=p.token;
     p.connected=false;p.disconnectedAt=Date.now();p.socketId=null;

     if(G.tournamentStarted){
       // 대회가 시작된 뒤에는 창을 닫아도 자리는 절대 비우지 않는다.
       // 베팅 단계라면 10초 자동베팅 타이머가 계속 적용된다.
       if(!G.gameStarted&&!G.tournamentOver){
         if(!p.confirmed&&!p.betDeadline)p.betDeadline=Date.now()+BET_SECONDS*1000;
         updateWaitingStatus();
         broadcast();
         armBettingClock();
       }else{
         broadcast();
       }
       return;
     }

     // 대회 시작 전에는 잠깐의 재접속 유예 후 빈 자리로 되돌린다.
     broadcast();
     setTimeout(()=>{
       const idx=byToken(token);
       if(idx<0)return;
       const current=G.players[idx];
       const reconnected=[...io.sockets.sockets.values()].some(s=>s.data.token===token);
       if(reconnected){current.connected=true;current.disconnectedAt=null;return}
       if(!G.tournamentStarted&&!G.gameStarted){
         G.players[idx]=null;
         updateWaitingStatus();broadcast();armBettingClock();
       }
     },20000);
   }
 });
 setTimeout(()=>socket.emit('state',snapshotFor(socket)),50);
});

server.listen(PORT,'0.0.0.0',()=>console.log(`BLACKJACK BASAN V19 tournament multiplayer on ${PORT}`));
