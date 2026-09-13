const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const {AsyncLocalStorage}=require('async_hooks');
const {randomUUID}=require('crypto');
const fs=require('fs');
const path=require('path');

const app=express();
const server=http.createServer(app);
const io=new Server(server,{pingInterval:12000,pingTimeout:25000});
const PORT=process.env.PORT||3000;
const ADMIN_PASSWORD='8959';
let activeAdminSessionToken='';
const adminSocketIds=new Set();
const START=1000000;
const WIN_TARGET=10000000;
const MIN_BET=10000;
const BET_SECONDS=15;
const INSURANCE_SECONDS=10;
const FINAL_SEATS=[3,6]; // 화면상 4번·7번 좌석
const RUNTIME_STATE_FILE=process.env.RUNTIME_STATE_PATH||path.join('/tmp','blackjack-basan-runtime-state.json');
let runtimeSaveTimer=null;

app.use(express.static(__dirname));
app.get('/health',(req,res)=>res.json({ok:true,version:'V46_FINAL_SEATS_4_7'}));

function makeGame(tableId){return {
 tableId,
 players:Array(10).fill(null),
 eliminatedSeats:Array(10).fill(null),
 gameStarted:false,dealing:false,settling:false,
 roundSettled:false,
 tournamentStarted:false,tournamentOver:false,winnerName:'',
 roundNo:1,dealerHand:[],deck:[],turnOrder:[],turnIndex:0,activeHandIndex:0,
 status:`${tableId==='F'?'결승':tableId+'테이블'} · 방장 게임 시작 대기 · 0 / ${tableId==='F'?2:10}`,
 countdown:null,betTimer:null,turnTimer:null,insuranceTimer:null,hideHole:false,
 insuranceOpen:false,insuranceDeadline:null,
 resultShowUntil:0
}}
let games={A:makeGame('A'),B:makeGame('B'),F:makeGame('F')};
const tableContext=new AsyncLocalStorage();
const currentTableId=()=>tableContext.getStore()?.tableId||'A';
const runTable=(tableId,fn)=>tableContext.run({tableId},fn);
const G=new Proxy({}, {
 get:(_,key)=>games[currentTableId()][key],
 set:(_,key,value)=>{games[currentTableId()][key]=value;return true}
});
const tournament={mode:'WAITING',qualifiers:{A:null,B:null},finalReady:false,eliminatedTokens:new Set()};

function serializableGame(game){
 const copy={...game,countdown:null,betTimer:null,turnTimer:null,insuranceTimer:null};
 copy.players=(game.players||[]).map(p=>p?{...p,socketId:null,connected:false}:null);
 return copy;
}
function saveRuntimeStateNow(){
 try{
   const payload={savedAt:Date.now(),games:Object.fromEntries(Object.entries(games).map(([id,g])=>[id,serializableGame(g)])),tournament:{...tournament,eliminatedTokens:[...tournament.eliminatedTokens]}};
   const temp=`${RUNTIME_STATE_FILE}.tmp`;
   fs.writeFileSync(temp,JSON.stringify(payload));
   fs.renameSync(temp,RUNTIME_STATE_FILE);
 }catch(err){console.error('runtime state save failed',err)}
}
function queueRuntimeSave(){
 if(runtimeSaveTimer)return;
 runtimeSaveTimer=setTimeout(()=>{runtimeSaveTimer=null;saveRuntimeStateNow()},120);
}
function restoreRuntimeState(){
 try{
   if(!fs.existsSync(RUNTIME_STATE_FILE))return false;
   const saved=JSON.parse(fs.readFileSync(RUNTIME_STATE_FILE,'utf8'));
   if(!saved?.games)return false;
   for(const id of ['A','B','F']){
     const src=saved.games[id];if(!src)continue;
     const restored=Object.assign(makeGame(id),src,{countdown:null,betTimer:null,turnTimer:null,insuranceTimer:null});
     restored.players=(restored.players||Array(10).fill(null)).map(p=>p?{...p,socketId:null,connected:false,disconnectedAt:Date.now()}:null);
     // 정산 전 서버가 재시작됐다면 해당 라운드는 무효로 하고 시작 전 보유금으로 복구한다.
     if((restored.gameStarted||restored.dealing||restored.settling)&&!restored.roundSettled){
       for(const p of restored.players){
         if(!p)continue;
         if(p.roundStartBank!==null&&p.roundStartBank!==undefined)p.bank=p.roundStartBank;
         p.bet={main:0,pair:0,trio:0};p.betLast={main:0,pair:0,trio:0};p.history=[];
         p.confirmed=false;p.autoConfirmed=false;p.betDeadline=null;p.betState='WAITING_BET';
         p.hands=[];p.initialCards=[];p.inRound=false;p.insuranceBet=0;p.insuranceDecision=null;
         p.roundStartBank=null;p.roundStake=0;p.roundNet=0;p.roundResult='';p.roundResultKind='';p.roundResultAmount=0;
       }
       restored.gameStarted=false;restored.dealing=false;restored.settling=false;restored.roundSettled=false;
       restored.dealerHand=[];restored.hideHole=false;restored.turnOrder=[];restored.turnIndex=0;restored.activeHandIndex=0;
       restored.status='서버 재연결 완료 · 중단 라운드 환불 · 베팅 재개';
     }
     games[id]=restored;
   }
   if(saved.tournament){
     tournament.mode=saved.tournament.mode||'WAITING';
     tournament.qualifiers=saved.tournament.qualifiers||{A:null,B:null};
     tournament.finalReady=!!saved.tournament.finalReady;
     tournament.eliminatedTokens=new Set(saved.tournament.eliminatedTokens||[]);
   }
   console.log('runtime state restored');return true;
 }catch(err){console.error('runtime state restore failed',err);return false}
}
const restoredAtBoot=restoreRuntimeState();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const moneySafe=n=>'₩'+Math.round(Number(n||0)).toLocaleString('ko-KR');
function makeDeck(){
 const suits=['♠','♥','♦','♣'],ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],d=[];
 for(let k=0;k<2;k++)for(const s of suits)for(const r of ranks)d.push({s,r});
 for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}
 return d;
}
function drawCard(){
 if(!G.deck.length)G.deck=makeDeck();
 return G.deck.pop();
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
function pairRuleName(cards,odds){
 if(!odds)return '';
 if(odds===25)return '퍼펙트 페어';
 if(odds===12)return '컬러 페어';
 return '믹스 페어';
}
function trioOdds(cards,up){
 if(!cards||cards.length<2||!up)return 0;
 const cs=[cards[0],cards[1],up],rs=cs.map(c=>rankNumber(c.r)).sort((a,b)=>a-b);
 const flush=cs.every(c=>c.s===cs[0].s),trips=rs[0]===rs[2];
 const straight=(rs[0]+1===rs[1]&&rs[1]+1===rs[2])||(rs[0]===2&&rs[1]===3&&rs[2]===14)||(rs[0]===12&&rs[1]===13&&rs[2]===14);
 if(trips&&flush)return 100;if(straight&&flush)return 40;if(trips)return 30;if(straight)return 10;if(flush)return 5;return 0;
}
function trioRuleName(odds){
 if(odds===100)return '수티드 트립스';
 if(odds===40)return '스트레이트 플러시';
 if(odds===30)return '트리플';
 if(odds===10)return '스트레이트';
 if(odds===5)return '플러시';
 return '';
}
function natural(h){return h.cards.length===2&&handValue(h.cards)===21&&!h.split}
function canSplit(p,h){
 if(!p||!h||h.cards.length!==2||h.state!=='PLAY'||p.hands.length>=4)return false;
 const splitValue=r=>['10','J','Q','K'].includes(r)?10:(r==='A'?11:Number(r));
 const ok=splitValue(h.cards[0].r)===splitValue(h.cards[1].r);
 return ok&&p.bank>=h.bet;
}
function canDouble(p,h){return !!(p&&h&&h.cards.length===2&&!h.doubled&&!h.splitAces&&p.bank>=h.bet)}
function canCashOut(p,h){return !!(p&&h&&h.state==='PLAY'&&handValue(h.cards)<=21)}
function cashOutOffer(h){
 if(!canCashOut({},h)||!G.dealerHand[0])return null;
 const playerTotal=handValue(h.cards);
 // The real hole card must not affect the offer. Put it back into the unknown
 // rank pool so the quote only uses information visible to the player.
 const unknown=[...G.deck];
 if(G.dealerHand[1])unknown.push(G.dealerHand[1]);
 const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
 const counts=ranks.map(r=>unknown.filter(c=>c.r===r).length);
 const memo=new Map();
 function dealerDist(total,soft,cs,left){
   while(total>21&&soft>0){total-=10;soft--}
   if(total>=17)return total>21?{bust:1}:{[total]:1};
   const key=`${total}|${soft}|${left}|${cs.join(',')}`;
   if(memo.has(key))return memo.get(key);
   const out={};
   for(let i=0;i<cs.length;i++){
     if(!cs[i])continue;
     const next=cs.slice();next[i]--;
     const rank=ranks[i],value=rank==='A'?11:(['10','J','Q','K'].includes(rank)?10:Number(rank));
     const d=dealerDist(total+value,soft+(rank==='A'?1:0),next,left-1);
     const weight=cs[i]/left;
     for(const [k,v] of Object.entries(d))out[k]=(out[k]||0)+v*weight;
   }
   memo.set(key,out);return out;
 }
 const up=G.dealerHand[0].r;
 const upValue=up==='A'?11:(['10','J','Q','K'].includes(up)?10:Number(up));
 const dist=dealerDist(upValue,up==='A'?1:0,counts,unknown.length);
 let win=dist.bust||0,push=0;
 for(let d=17;d<=21;d++){
   const prob=dist[d]||0;
   if(playerTotal>d)win+=prob;
   else if(playerTotal===d)push+=prob;
 }
 const fairReturn=h.bet*(2*win+push);
 const amount=Math.max(0,Math.min(h.bet*2,Math.floor(fairReturn/100)*100));
 return {amount,percent:Math.round(amount/h.bet*100),playerTotal};
}
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
 G.insuranceDeadline=null;G.resultShowUntil=0;
}
function reserveEliminatedSeat(i,p,reason='탈락'){
 if(i<0||i>9)return;
 G.eliminatedSeats[i]={
   name:p?.name||`SEAT ${i+1}`,
   reason,
   bank:Number(p?.bank||0)
 };
 if(p?.token)tournament.eliminatedTokens.add(p.token);
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
 const publicMySeat=mySeat>=0?mySeat:null;
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
   canSurrender:turnSeat===mySeat&&canCashOut(p,h),
   cashOutOffer:turnSeat===mySeat?cashOutOffer(h):null,
   insuranceOpen:G.insuranceOpen,
   insuranceDeadline:G.insuranceDeadline,
   insuranceSeconds:INSURANCE_SECONDS,
   resultShowUntil:G.resultShowUntil||0,
   mySeat:publicMySeat,serverNow:Date.now(),betSeconds:BET_SECONDS,
   tableId:currentTableId(),tableLabel:currentTableId()==='F'?'결승 테이블':`${currentTableId()} 테이블`,
   tournamentMode:tournament.mode,
   tableCounts:{A:games.A.players.filter(Boolean).length,B:games.B.players.filter(Boolean).length},
   qualifiers:{A:tournament.qualifiers.A?.name||'',B:tournament.qualifiers.B?.name||''},
   finalReady:tournament.finalReady,
   isQualifier:['A','B'].some(k=>tournament.qualifiers[k]?.token===socket.data.token),
   canSpectate:tournament.eliminatedTokens.has(String(socket.data.token||'')),
   adminActive:!!activeAdminSessionToken,
   isAdmin:adminSocketIds.has(socket.id)
 };
}
function broadcast(){
 const tableId=currentTableId();
 for(const s of io.sockets.sockets.values()){
   if(s.data.tableId===tableId)s.emit('state',snapshotFor(s));
 }
 queueRuntimeSave();
}
function broadcastAll(){for(const id of ['A','B','F'])runTable(id,broadcast)}
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
   G.status=`${currentTableId()==='F'?'결승':currentTableId()+'테이블'} · 방장 게임 시작 대기 · ${alive.length} / ${currentTableId()==='F'?2:10}`;
 }else{
   G.status=`생존 ${alive.length}명 · 베팅 완료 ${done} / ${alive.length}${remain?` · ${remain}초`:''}`;
 }
}
function finishTournament(entry){
 stopBetTimer();stopTurnTimer();clearCountdown();
 G.gameStarted=false;G.dealing=false;G.settling=false;G.tournamentOver=true;G.tournamentStarted=true;
 G.winnerName=entry?.p?.name||'WINNER';
 const tableId=currentTableId();
 for(let i=0;i<G.players.length;i++){
   const p=G.players[i];
   if(!p)continue;
   if(i!==entry?.i){
     const runnerUpReason=tableId==='F'
       ?`준우승 · ${G.winnerName} 우승`
       :(p.eliminatedPending?'BUST 탈락':'탈락');
     reserveEliminatedSeat(i,p,runnerUpReason);
     G.players[i]=null;
   }else{
     G.players[i].confirmed=true;
     G.players[i].betDeadline=null;
     G.players[i].lastAction='CHAMPION';
     G.players[i].roundResult=tableId==='F'||tournament.mode==='SINGLE'?'🏆 FINAL WINNER':'🏆 예선 우승 · 결승 진출';
   }
 }
 if(tableId!=='F'&&tournament.mode==='SPLIT'){
   tournament.qualifiers[tableId]={name:G.winnerName,token:entry.p.token};
   G.status=`🏆 ${G.winnerName} ${tableId}테이블 우승 · 결승 진출 확정`;
   if(tournament.qualifiers.A&&tournament.qualifiers.B)prepareFinal();
 }else{
   G.status=`🏆 ${G.winnerName} 최종 우승 · TOURNAMENT COMPLETE`;
 }
 broadcastAll();
}

function makeFinalPlayer(q,seat){return {
 token:q.token,socketId:null,connected:false,disconnectedAt:null,inactiveTurns:0,name:q.name,bank:START,
 bet:{main:0,pair:0,trio:0},betLast:{main:0,pair:0,trio:0},previousBet:{main:0,pair:0,trio:0},history:[],
 confirmed:false,autoConfirmed:false,betDeadline:null,betState:'WAITING_BET',hands:[],roundResult:'',
 lastAction:'WAIT',eliminatedPending:false,insuranceBet:0,insuranceDecision:null,
 roundStartBank:null,roundStake:0,roundNet:0,roundResultKind:'',roundResultAmount:0,finalSeat:seat
}}
function prepareFinal(){
 const finalGame=makeGame('F');
 finalGame.players[FINAL_SEATS[0]]=makeFinalPlayer(tournament.qualifiers.A,FINAL_SEATS[0]);
 finalGame.players[FINAL_SEATS[1]]=makeFinalPlayer(tournament.qualifiers.B,FINAL_SEATS[1]);
 finalGame.status=`결승 준비 · ${tournament.qualifiers.A.name} VS ${tournament.qualifiers.B.name}`;
 games.F=finalGame;tournament.finalReady=true;
}
function checkFinalWinner(){
 if(currentTableId()==='F'&&!G.roundSettled)return false;
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

// 결승에서 두 참가자가 같은 라운드에 전액 올인 후 모두 패배한 특수 상황만
// 마지막 패의 21 근접도로 결정한다. 일반 잔액 부족 탈락 판정에는 사용하지 않는다.
function finalAllInLossRank(p){
 const hands=(p?.hands||[]).filter(h=>Array.isArray(h.cards)&&h.cards.length);
 const valid=hands.map(h=>handValue(h.cards)).filter(v=>v<=21);
 if(valid.length)return {category:2,score:Math.max(...valid)};
 const bust=hands.map(h=>handValue(h.cards)).filter(v=>v>21);
 if(bust.length)return {category:1,score:-Math.min(...bust.map(v=>v-21))};
 return {category:0,score:-Infinity};
}
function isFinalAllInRoundLoss(p){
 if(!p||Number(p.bank||0)!==0||Number(p.roundStake||0)<=0)return false;
 const hands=p.hands||[];
 return hands.length>0&&hands.every(h=>h.result==='LOSE'||h.result==='BUST'||h.state==='BUST'||handValue(h.cards)>21);
}

function resetCurrentTable(){
 stopBetTimer();stopTurnTimer();stopInsuranceTimer();clearCountdown();

 G.players=Array(10).fill(null);
 G.eliminatedSeats=Array(10).fill(null);
 G.gameStarted=false;
 G.dealing=false;
 G.settling=false;
 G.roundSettled=false;
 G.tournamentStarted=false;
 G.tournamentOver=false;
 G.winnerName='';
 G.roundNo=1;
 G.dealerHand=[];
 G.deck=[];
 G.turnOrder=[];
 G.turnIndex=0;
 G.activeHandIndex=0;
 G.status=`${currentTableId()==='F'?'결승':currentTableId()+'테이블'} · 방장 게임 시작 대기 · 0 / ${currentTableId()==='F'?2:10}`;
 G.countdown=null;
 G.betTimer=null;
 G.turnTimer=null;
 G.insuranceTimer=null;
 G.hideHole=false;
 G.insuranceOpen=false;
 G.insuranceDeadline=null;

 broadcast();
}

function resetTournament(){
 for(const id of ['A','B','F'])runTable(id,resetCurrentTable);
 tournament.mode='WAITING';tournament.qualifiers={A:null,B:null};tournament.finalReady=false;tournament.eliminatedTokens=new Set();
 for(const s of io.sockets.sockets.values())s.data.token='';
 broadcastAll();io.emit('tournamentReset');
}


function adminStartGame(){
 if(G.tournamentOver)return {ok:false,msg:'우승 처리 후 게임판 종료/초기화를 먼저 해주세요.'};
 if(G.tournamentStarted||G.gameStarted)return {ok:false,msg:'이미 게임이 진행 중입니다.'};
 const alive=alivePlayers();
 if(alive.length<1)return {ok:false,msg:'참가자가 1명 이상 착석해야 시작할 수 있습니다.'};

 G.tournamentStarted=true;
 G.gameStarted=false;

 // 중요:
 // START 전에 이미 '베팅 완료'한 사람은 금액이 이미 1회 차감된 상태다.
 // confirmed를 풀어버리면 같은 금액이 다시 차감되어 올인/고액 베터가 탈락하는 버그가 생긴다.
 // 따라서 완료된 베팅은 그대로 인정하고, 미완료자에게만 15초 타이머를 건다.
 let done=0;
 for(const p of alive){
   if(p.confirmed){
     done++;
     p.betDeadline=null;
     p.betState=p.autoConfirmed?'AUTO_CONFIRMED':'CONFIRMED';
   }else{
     p.autoConfirmed=false;
     p.betDeadline=null;
     p.betState=(p.bet.main+p.bet.pair+p.bet.trio)>0?'BETTING':'WAITING_BET';
   }
 }

 G.status=`방장 START · 참가자 ${alive.length}명 · 베팅 완료 ${done}/${alive.length}`;
 broadcast();
 armBettingClock();
 return {ok:true};
}

function startTournamentByAttendance(){
 const a=games.A.players.filter(Boolean).length,b=games.B.players.filter(Boolean).length,total=a+b;
 if(total<1)return {ok:false,msg:'참가자가 1명 이상 착석해야 시작할 수 있습니다.'};
 if(b===0){
   tournament.mode='SINGLE';
   return runTable('A',adminStartGame);
 }
 if(a<1)return {ok:false,msg:'A테이블에 참가자가 1명 이상 있어야 A·B 예선을 시작할 수 있습니다.'};
 tournament.mode='SPLIT';
 const ra=runTable('A',adminStartGame),rb=runTable('B',adminStartGame);
 broadcastAll();
 return ra.ok&&rb.ok?{ok:true}:{ok:false,msg:ra.msg||rb.msg};
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
 if(p.roundStartBank===null||p.roundStartBank===undefined)p.roundStartBank=p.bank;
 p.roundStake=(p.roundStake||0)+total;
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
     const p=G.players[i];
     // 이미 베팅 확정된 플레이어(올인 포함)는 재확정/재차감 금지.
     if(!p||p.confirmed||!p.betDeadline)continue;
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
 G.gameStarted=true;G.dealing=true;G.settling=false;G.roundSettled=false;G.dealerHand=[];
 // Keep one continuous two-deck shoe. Shuffle before a round when the cut-card
 // point is reached; player seats, bankrolls and tournament state stay intact.
 if(G.deck.length<26)G.deck=makeDeck();
 G.turnOrder=[];G.turnIndex=0;G.activeHandIndex=0;G.hideHole=false;

 G.players.forEach((p,i)=>{
   if(!p||!p.confirmed)return;
   p.hands=[{cards:[],bet:p.bet.main,state:'PLAY',doubled:false,split:false,result:''}];
   p.initialCards=[];p.inRound=true;p.roundResult='';p.sideResult={pair:null,trio:null};
   p.lastAction='WAIT';p.eliminatedPending=false;p.betDeadline=null;
   p.insuranceBet=0;p.insuranceDecision=null;
   G.turnOrder.push(i);
 });
 for(const i of G.turnOrder){
   if(!G.players[i])continue;
   G.status=`ROUND ${G.roundNo} · ${G.players[i].name} 첫 번째 카드`;
   G.players[i].hands[0].cards.push(drawCard());broadcast();await sleep(330)
 }
 G.status=`ROUND ${G.roundNo} · 딜러 오픈카드`;
 G.dealerHand.push(drawCard());broadcast();await sleep(500);
 for(const i of G.turnOrder){
   const p=G.players[i];if(!p)continue;
   const h=p.hands[0];
   G.status=`ROUND ${G.roundNo} · ${p.name} 두 번째 카드`;
   h.cards.push(drawCard());p.initialCards=h.cards.map(c=>({...c}));
   if(handValue(h.cards)===21){h.state='STAND';p.lastAction='BLACKJACK'}
   broadcast();await sleep(330);
 }
 G.status=`ROUND ${G.roundNo} · 딜러 비하인드 카드`;
 G.dealerHand.push(drawCard());G.hideHole=true;broadcast();await sleep(500);
 G.dealing=false;
 if(G.dealerHand[0]?.r==='A'){
   openInsurance();
 }else if(['10','J','Q','K'].includes(G.dealerHand[0]?.r)&&natural({cards:G.dealerHand,split:false})){
   G.status='딜러 BLACKJACK';G.hideHole=false;broadcast();setTimeout(settle,1100);
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
   : `${p.name} 차례 · 행동시간 10초 · HIT / STAND / DOUBLE / SPLIT / 인출`;
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
 G.settling=true;G.hideHole=false;G.status='딜러 비하인드 카드 오픈';broadcast();await sleep(1100);
 while(handValue(G.dealerHand)<17){
   G.status=`딜러 ${handValue(G.dealerHand)} · HIT`;
   G.dealerHand.push(drawCard());broadcast();await sleep(1100)
 }
 G.status=`딜러 ${handValue(G.dealerHand)} · 정산`;broadcast();await sleep(500);settle();
}
function settle(){
 const dv=handValue(G.dealerHand),db=dv>21,dbj=G.dealerHand.length===2&&dv===21;
 for(const p of G.players){
   if(!p||!p.inRound)continue;
   // 다음 라운드의 '이전 베팅' 버튼에서 MAIN·사이드 금액을 그대로 불러온다.
   p.previousBet={main:Number(p.bet.main||0),pair:Number(p.bet.pair||0),trio:Number(p.bet.trio||0)};
   const texts=[];
   p.sideResult={pair:null,trio:null};
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
     if(h.state==='CASHOUT'||h.result==='인출')res=`인출 ${moneySafe(h.cashOutAmount)}`;
     else if(v>21)res='LOSE';
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
     if(o){
       const rule=pairRuleName(p.initialCards,o);
       p.bank+=p.bet.pair*(o+1);
       p.sideResult.pair={win:true,rule,multiplier:o,profit:p.bet.pair*o};
       texts.push(`${rule} ${o}:1`)
     }else{
       p.sideResult.pair={win:false,multiplier:0,profit:0};
       texts.push('PP LOSE')
     }
   }
   if(p.bet.trio>0){
     const o=trioOdds(p.initialCards,G.dealerHand[0]);
     if(o){
       const rule=trioRuleName(o);
       p.bank+=p.bet.trio*(o+1);
       p.sideResult.trio={win:true,rule,multiplier:o,profit:p.bet.trio*o};
       texts.push(`${rule} ${o}:1`)
     }else{
       p.sideResult.trio={win:false,multiplier:0,profit:0};
       texts.push('21+3 LOSE')
     }
   }
   const allBust=p.hands.length>0&&p.hands.every(h=>h.state==='BUST'||handValue(h.cards)>21);
   if(allBust){
     p.lastAction='BUST';
     texts.push(p.bank>=MIN_BET?'BUST · 생존':'BUST · 잔액 소진');
   }else if(p.lastAction==='TURN'||p.lastAction==='WAIT'){
     p.lastAction='ROUND DONE';
   }
   p.roundResult=texts.join(' · ');

   // 라운드 시작 직전 보유금 대비 최종 보유금 = 정확한 개인 순손익.
   const startBank=(p.roundStartBank===null||p.roundStartBank===undefined)?p.bank:p.roundStartBank;
   p.roundNet=Math.round(p.bank-startBank);
   p.roundResultAmount=Math.abs(p.roundNet);
   p.roundResultKind=p.roundNet>0?'WIN':(p.roundNet<0?'LOSE':'PUSH');
 }
 G.settling=false;G.roundSettled=true;

 // 정산이 모두 끝난 시점의 실제 보유금으로 목표 우승 판정.
 // 10,000,000원 이상이 여러 명이면 그중(=전체 생존자 중) 보유금 최고액 1명이 즉시 우승.
 if(checkTargetWinner())return;

 const brokeCount=alivePlayers().filter(p=>p.bank<MIN_BET).length;
 G.resultShowUntil=Date.now()+7000;
 G.status=`ROUND ${G.roundNo} 승리금액 롤러 · 7초 후 다음 베팅`;
 broadcast();setTimeout(nextRound,7000);
}
function nextRound(){
 stopTurnTimer();stopInsuranceTimer();
 G.insuranceOpen=false;
 G.resultShowUntil=0;
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
   let fallback;
   const finalDoubleAllInLoss=currentTableId()==='F'&&before.length===2&&before.every(({p})=>isFinalAllInRoundLoss(p));
   if(finalDoubleAllInLoss){
     fallback=[...before].sort((a,b)=>{
       const ar=finalAllInLossRank(a.p),br=finalAllInLossRank(b.p);
       return br.category-ar.category||br.score-ar.score||a.i-b.i;
     })[0];
     const winnerRank=finalAllInLossRank(fallback.p);
     G.status=`결승 동시 올인 패배 · 마지막 패 ${winnerRank.category===2?winnerRank.score:21-winnerRank.score} 비교 · ${fallback.p.name} 우승`;
   }else{
     fallback=[...before].sort((a,b)=>b.p.bank-a.p.bank||a.i-b.i)[0];
   }
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
   p.sideResult={pair:null,trio:null};
   p.insuranceBet=0;p.insuranceDecision=null;
   p.roundStartBank=null;p.roundStake=0;p.roundNet=0;p.roundResultKind='';p.roundResultAmount=0;
 }
 G.roundSettled=false;
 updateWaitingStatus();broadcast();
 armBettingClock();
}

io.on('connection',socket=>{
 const requested=String(socket.handshake.query?.table||'A').toUpperCase();
 const tableId=['A','B','F'].includes(requested)?requested:'A';
 socket.data.tableId=tableId;
 // 한 참가자의 잘못된/중복 요청이 예외를 내더라도 Node 프로세스 전체가
 // 종료되어 A·B 참가자 전원이 동시에 끊기지 않도록 소켓 요청을 격리한다.
 const on=(event,handler)=>socket.on(event,(...args)=>{
   try{
     const result=runTable(tableId,()=>handler(...args));
     if(result&&typeof result.then==='function')result.catch(err=>{
       console.error(`[${tableId}] socket ${event} async error`,err);
       socket.emit('actionError','요청 처리 중 오류가 발생했습니다. 다시 눌러주세요.');
     });
   }catch(err){
     console.error(`[${tableId}] socket ${event} error`,err);
     socket.emit('actionError','요청 처리 중 오류가 발생했습니다. 다시 눌러주세요.');
   }
 });
 on('takeSeat',({seat,name,token})=>{
   if(clearStaleWaitingSeats())updateWaitingStatus();
   seat=Number(seat);name=String(name||'').trim().slice(0,12);token=String(token||'');
   socket.data.token=token;
   if(!token||seat<0||seat>9)return socket.emit('seatError','잘못된 좌석 요청입니다.');
   if(tableId==='F'&&byToken(token)<0)return socket.emit('seatError','결승 진출자만 결승 테이블에 앉을 수 있습니다.');
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
     bet:{main:0,pair:0,trio:0},betLast:{main:0,pair:0,trio:0},previousBet:{main:0,pair:0,trio:0},history:[],
     confirmed:false,autoConfirmed:false,betDeadline:null,betState:'WAITING_BET',
     hands:[],roundResult:'',lastAction:'WAIT',eliminatedPending:false,insuranceBet:0,insuranceDecision:null,
     roundStartBank:null,roundStake:0,roundNet:0,roundResultKind:'',roundResultAmount:0
   };
   socket.emit('seatOk',{seat});updateWaitingStatus();broadcast();armBettingClock();
 });
 on('leaveSeat',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i<0)return socket.emit('seatLeft');
   const p=G.players[i];
   if(G.tournamentStarted)return socket.emit('seatError','대회 진행 중에는 자리를 비울 수 없습니다.');
   if(p.confirmed)return socket.emit('seatError','베팅 완료 후에는 자리를 비울 수 없습니다.');
   G.players[i]=null;socket.emit('seatLeft');updateWaitingStatus();broadcast();armBettingClock();
 });
 on('hello',({token})=>{
   socket.data.token=String(token||'');
   const i=byToken(socket.data.token);
   if(i>=0){
     G.players[i].socketId=socket.id;G.players[i].connected=true;G.players[i].disconnectedAt=null;
   }
   broadcast();
 });
 on('finalEnter',({token})=>{
   if(tableId!=='F'||!tournament.finalReady)return;
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p)return socket.emit('actionError','결승 진출자 확인이 필요합니다.');
   p.finalReady=true;broadcast();
   if(FINAL_SEATS.every(seat=>G.players[seat]&&G.players[seat].connected&&G.players[seat].finalReady)&&!G.tournamentStarted){
     setTimeout(()=>runTable('F',()=>{if(!G.tournamentStarted)adminStartGame()}),700);
   }
 });
 on('betAdd',({token,mode,value})=>{
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
 on('betUndo',({token})=>{
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
 on('betRepeat',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p||G.gameStarted||G.tournamentOver||p.confirmed)return;
   const prev=p.previousBet||{main:0,pair:0,trio:0};
   const next={main:Number(prev.main||0),pair:Number(prev.pair||0),trio:Number(prev.trio||0)};
   const total=next.main+next.pair+next.trio;
   if(total<=0)return socket.emit('actionError','저장된 이전 베팅이 없습니다.');
   if(total>p.bank)return socket.emit('actionError',`이전 베팅 ${moneySafe(total)}을 적용하기에 보유금이 부족합니다.`);
   p.bet=next;
   p.betLast={main:next.main||0,pair:next.pair||0,trio:next.trio||0};
   p.history=[];
   for(const mode of ['main','pair','trio'])if(next[mode]>0)p.history.push({mode,v:next[mode]});
   p.betState='BETTING';
   G.status=`${p.name} · 이전 베팅 불러오기 ${moneySafe(total)}`;
   broadcast();
 });
 on('betClear',({token})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!p||G.gameStarted||G.tournamentOver||p.confirmed)return;
   p.bet={main:0,pair:0,trio:0};p.betLast={main:0,pair:0,trio:0};p.history=[];p.betState='WAITING_BET';broadcast();
 });
 on('betConfirm',({token})=>{
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
 on('insuranceChoice',({token,take})=>{
   const i=byToken(String(token||'')),p=G.players[i];
   if(!G.insuranceOpen||!p||!p.inRound||p.insuranceDecision!==null)return;
   const amount=Math.floor((p.bet.main||0)/2);
   if(take){
     if(amount<=0)return socket.emit('actionError','MAIN 베팅이 없어 인슈어런스를 선택할 수 없습니다.');
     if(p.bank<amount)return socket.emit('actionError','인슈어런스 베팅에 필요한 보유금이 부족합니다.');
     if(p.roundStartBank===null||p.roundStartBank===undefined)p.roundStartBank=p.bank;
     p.roundStake=(p.roundStake||0)+amount;
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
 on('turnAction',({token,action})=>{
   const i=byToken(String(token||'')),[seat,p,h]=current();
   if(i<0||i!==seat||!p||!h||h.state!=='PLAY'||G.dealing||G.settling||G.insuranceOpen)return;
   // A-A 스플릿 핸드는 카드 1장 지급 후 종료이므로 추가 액션 금지.
   if(h.splitAces && (action==='hit'||action==='double')){
     h.state='STAND';
     p.lastAction='A-A SPLIT · 자동 STAND';
     G.status=`${p.name} A-A SPLIT · 추가 HIT/DOUBLE 불가`;
     broadcast();
     return setTimeout(advanceTurn,180);
   }

   stopTurnTimer();
   p.inactiveTurns=0;

   if(action==='hit'){
     p.lastAction='HIT';
     h.cards.push(drawCard());
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
   }else if(action==='surrender'){
     if(!canCashOut(p,h))return;
     const offer=cashOutOffer(h);
     if(!offer)return;
     p.bank+=offer.amount;
     h.cashOutAmount=offer.amount;
     h.cashOutPercent=offer.percent;
     h.state='CASHOUT';h.result='인출';
     p.lastAction='인출';
     G.activeHandIndex++;G.status=`${p.name} 인출 · ${offer.playerTotal}점 · ${offer.percent}% · ${moneySafe(offer.amount)} 정산`;
     broadcast();setTimeout(advanceTurn,300);
   }else if(action==='double'){
     if(!canDouble(p,h))return;
     if(p.roundStartBank===null||p.roundStartBank===undefined)p.roundStartBank=p.bank;
     p.roundStake=(p.roundStake||0)+h.bet;
     p.bank-=h.bet;h.bet*=2;h.doubled=true;h.cards.push(drawCard());
     const v=handValue(h.cards);
     if(v>21){h.state='BUST';h.result='BUST';p.lastAction='DOUBLE · BUST'}
     else{h.state='STAND';p.lastAction='DOUBLE · STAND'}
     G.activeHandIndex++;broadcast();setTimeout(advanceTurn,360);
   }else if(action==='split'){
     if(!canSplit(p,h))return;
     p.lastAction='SPLIT';
     if(p.roundStartBank===null||p.roundStartBank===undefined)p.roundStartBank=p.bank;
     p.roundStake=(p.roundStake||0)+h.bet;
     p.bank-=h.bet;const [c1,c2]=h.cards,bet=h.bet;

     // A-A 스플릿은 각 A에 딱 1장씩만 지급하고 즉시 종료.
     // 스플릿 A 핸드에는 HIT / DOUBLE을 허용하지 않는다.
     const splitAces=(c1.r==='A'&&c2.r==='A');
     const h1={cards:[c1,drawCard()],bet,state:'PLAY',doubled:false,split:true,splitAces,result:''};
     const h2={cards:[c2,drawCard()],bet,state:'PLAY',doubled:false,split:true,splitAces,result:''};

     // A-A는 각 핸드에 한 장만 지급한다. 단, 다시 A를 받았다면
     // 최대 4핸드 범위에서 재스플릿 선택만 허용한다.
     if(splitAces){
       for(const x of [h1,h2]){
         const pairOfAces=x.cards[0].r==='A'&&x.cards[1].r==='A';
         if(!pairOfAces)x.state='STAND';
       }
     }

     if(!splitAces){
       for(const x of [h1,h2]){
         const v=handValue(x.cards);
         if(v>21){x.state='BUST';x.result='BUST'}
         else if(v===21)x.state='STAND'
       }
     }

     p.hands.splice(G.activeHandIndex,1,h1,h2);

     if(splitAces){
       const canResplitNow=p.hands.some(x=>x.state==='PLAY'&&x.splitAces&&x.cards.length===2&&x.cards[0].r==='A'&&x.cards[1].r==='A')&&p.hands.length<4;
       if(!canResplitNow){
         for(const x of p.hands)if(x.splitAces&&x.state==='PLAY')x.state='STAND';
       }
       p.lastAction=canResplitNow?'A-A SPLIT · 재스플릿 선택 가능':'A-A SPLIT · 1장씩 지급 · 자동 STAND';
       G.status=canResplitNow
         ?`${p.name} A-A SPLIT · 최대 4핸드까지 재스플릿 가능`
         :`${p.name} A-A SPLIT · 각 핸드 1장 지급 후 자동 STAND`;
       broadcast();
       return setTimeout(advanceTurn,450);
     }

     broadcast();
     if(p.hands[G.activeHandIndex].state!=='PLAY'){G.activeHandIndex++;setTimeout(advanceTurn,220)}
   }
 });
 on('resetTournament',({token})=>{
   socket.data.token=String(token||'');
   if(!G.tournamentOver)return socket.emit('actionError','대회 종료 후에만 리셋할 수 있습니다.');
   resetTournament();
 });

 on('adminLogin',({password})=>{
   if(String(password||'')!==ADMIN_PASSWORD){
     return socket.emit('adminLoginResult',{ok:false,msg:'비밀번호가 틀렸습니다.'});
   }
   if(!activeAdminSessionToken)activeAdminSessionToken=randomUUID();
   adminSocketIds.add(socket.id);
   socket.data.isAdmin=true;
   socket.emit('adminLoginResult',{ok:true,adminSession:activeAdminSessionToken});
   broadcastAll();
 });
 on('adminResume',({adminSession})=>{
   if(!activeAdminSessionToken||String(adminSession||'')!==activeAdminSessionToken)return;
   adminSocketIds.add(socket.id);socket.data.isAdmin=true;
   socket.emit('adminLoginResult',{ok:true,adminSession:activeAdminSessionToken,resumed:true});
   broadcastAll();
 });

 on('adminStartGame',()=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   const r=tableId==='F'?adminStartGame():startTournamentByAttendance();
   if(!r.ok)socket.emit('actionError',r.msg);
 });

 on('adminMovePlayer',({seat,targetTable})=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   targetTable=String(targetTable||'').toUpperCase();
   if(!['A','B'].includes(tableId)||!['A','B'].includes(targetTable)||targetTable===tableId){
     return socket.emit('actionError','A·B테이블 사이에서만 참가자를 이동할 수 있습니다.');
   }
   seat=Number(seat);
   if(games.A.tournamentStarted||games.B.tournamentStarted||games.A.gameStarted||games.B.gameStarted){
     return socket.emit('actionError','게임 시작 후에는 참가자를 이동할 수 없습니다.');
   }
   const player=G.players[seat];
   if(!player)return socket.emit('actionError','이동할 참가자가 없는 자리입니다.');
   const targetGame=games[targetTable];
   let targetSeat=!targetGame.players[seat]?seat:targetGame.players.findIndex(x=>!x);
   if(targetSeat<0)return socket.emit('actionError',`${targetTable}테이블에 빈자리가 없습니다.`);
   G.players[seat]=null;
   targetGame.players[targetSeat]=player;
   const playerSocket=io.sockets.sockets.get(player.socketId);
   if(playerSocket)playerSocket.emit('movedToTable',{table:targetTable,seat:targetSeat});
   runTable(targetTable,()=>{updateWaitingStatus();broadcast()});
   updateWaitingStatus();broadcast();
   socket.emit('adminMoveResult',{ok:true,name:player.name,table:targetTable,seat:targetSeat});
 });

 on('adminKickPlayer',({seat})=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   if(!['A','B'].includes(tableId))return socket.emit('actionError','A·B테이블 참가자만 강퇴할 수 있습니다.');
   seat=Number(seat);
   const player=G.players[seat];
   if(!player)return socket.emit('actionError','강퇴할 참가자가 없는 자리입니다.');

   const wasCurrentTurn=G.gameStarted&&G.turnOrder[G.turnIndex]===seat;
   const playerSocket=player.socketId?io.sockets.sockets.get(player.socketId):null;
   if(G.tournamentStarted)reserveEliminatedSeat(seat,player,'방장 강퇴');
   G.players[seat]=null;
   if(playerSocket){
     playerSocket.data.token='';
     playerSocket.emit('adminKicked',{name:player.name,table:tableId});
   }

   G.status=`${player.name} · 방장 강퇴`;
   updateWaitingStatus();broadcast();
   socket.emit('adminKickResult',{ok:true,name:player.name,table:tableId,seat});

   if(G.tournamentStarted&&!G.tournamentOver){
     if(checkFinalWinner())return;
     if(wasCurrentTurn){
       stopTurnTimer();
       G.activeHandIndex=0;
       setTimeout(()=>runTable(tableId,advanceTurn),150);
     }else if(!G.gameStarted){
       armBettingClock();
     }
   }else{
     armBettingClock();
   }
 });

 on('adminStopGame',()=>{
   if(!socket.data.isAdmin)return socket.emit('actionError','방장 권한이 필요합니다.');
   adminStopGame();
 });
 on('disconnect',()=>{
   if(adminSocketIds.has(socket.id)){
     adminSocketIds.delete(socket.id);socket.data.isAdmin=false;
     setTimeout(()=>broadcastAll(),0);
   }
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
 setTimeout(()=>runTable(tableId,()=>socket.emit('state',snapshotFor(socket))),50);
});

process.on('uncaughtException',err=>{
 console.error('uncaught exception - saving state for restart',err);
 saveRuntimeStateNow();
 setTimeout(()=>process.exit(1),100);
});
process.on('unhandledRejection',err=>{
 console.error('unhandled rejection - saving state for restart',err);
 saveRuntimeStateNow();
 setTimeout(()=>process.exit(1),100);
});
process.on('SIGTERM',()=>{saveRuntimeStateNow();process.exit(0)});

server.listen(PORT,'0.0.0.0',()=>{
 console.log(`BLACKJACK BASAN V46 final-seats-4-7 on ${PORT}`);
 if(restoredAtBoot){
   for(const id of ['A','B','F'])runTable(id,()=>{
     if(G.tournamentStarted&&!G.tournamentOver&&!G.gameStarted&&alivePlayers().length>1)armBettingClock();
   });
 }
});
