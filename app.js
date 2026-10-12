'use strict';

const SERVICE = '00001623-1212-efde-1623-785feabcd123';
const CHAR = '00001624-1212-efde-1623-785feabcd123';
const PORT_MOTOR = 0x00, PORT_SPEAKER = 0x01, PORT_LED = 0x11, PORT_COLOR = 0x12;
const SOUND_BRAKE = 3, SOUND_WATER = 7, SOUND_HORN = 9;
const COLORS = { BLACK:0, PURPLE:2, BLUE:3, GREEN:6, YELLOW:7, RED:9, WHITE:10 };
const lampCycle = [COLORS.WHITE,COLORS.YELLOW,COLORS.BLUE,COLORS.GREEN,COLORS.RED,COLORS.PURPLE,COLORS.BLACK];
const lampCss = { 0:'transparent',2:'#a449dc',3:'#2878ff',6:'#2dd248',7:'#ffe11e',9:'#ff372d',10:'#ffffff' };

let device=null, characteristic=null, currentSpeed=0, lampColor=COLORS.BLACK;
let lastHandledColor=-1, lastHandledColorMs=0, pendingColor=null, colorTimer=null, blueResumeTimer=null;
let writeChain=Promise.resolve(), reconnectTimer=null;

const $=id=>document.getElementById(id);
const speedInput=$('speedInput'), knob=$('knob'), btDot=$('btDot'), toast=$('toast');

function say(msg, ms=1800){ toast.textContent=msg; toast.classList.add('show'); clearTimeout(say.t); say.t=setTimeout(()=>toast.classList.remove('show'),ms); }
function setBt(state){
  btDot.style.background = state==='ready' ? '#24d33e' : state==='connecting' ? '#ffd21f' : '#e53935';
  btDot.style.color = btDot.style.background;
}
function setKnob(v){
  currentSpeed=Math.max(-100,Math.min(100,Number(v)||0));
  speedInput.value=currentSpeed;
  knob.style.left=((currentSpeed+100)/2)+'%';
}
function setLampVisual(c){
  lampColor=c; const css=lampCss[c]||'transparent';
  for(const id of ['lampGlowFront','lampGlowTop']){ const el=$(id); el.style.color=css; el.classList.toggle('glowOn',c!==COLORS.BLACK); }
}

function packet(payload){ const a=new Uint8Array(payload.length+2); a[0]=a.length; a[1]=0; payload.forEach((v,i)=>a[i+2]=v); return a; }
async function rawWrite(bytes){
  if(!characteristic) return false;
  try {
    if(characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(bytes);
    else await characteristic.writeValue(bytes);
    return true;
  } catch(e){ console.warn('BLE write',e); return false; }
}
function send(...payload){
  const bytes=packet(payload);
  writeChain=writeChain.then(async()=>{ await rawWrite(bytes); await new Promise(r=>setTimeout(r,35)); });
  return writeChain;
}
function mapSpeed(v){ if(v===0)return 127; if(v>0)return Math.round((v/100)*126); return 255-Math.round((Math.abs(v)/100)*127); }
function setSpeed(v, fromRail=false){
  v=Math.max(-100,Math.min(100,Math.round(v))); currentSpeed=v; setKnob(v);
  return send(0x81,PORT_MOTOR,0x11,0x51,0x00,mapSpeed(v));
}
function sound(id){ return send(0x81,PORT_SPEAKER,0x11,0x51,0x01,id); }
function setLamp(c){ setLampVisual(c); return send(0x81,PORT_LED,0x11,0x51,0x00,c); }
function cycleLamp(){ let i=lampCycle.indexOf(lampColor); setLamp(lampCycle[(i+1)%lampCycle.length]); }

async function initializeTrain(){
  // Same sequence as the native version: configure lamp, speaker and color sensor.
  await send(0x41,PORT_LED,0x00,0x01,0x00,0x00,0x00,0x00);
  await new Promise(r=>setTimeout(r,70));
  await send(0x41,PORT_SPEAKER,0x01,0x01,0x00,0x00,0x00,0x01);
  await new Promise(r=>setTimeout(r,90));
  await send(0x41,PORT_COLOR,0x00,0x01,0x00,0x00,0x00,0x01);
}

async function attachDevice(d){
  device=d; setBt('connecting');
  device.addEventListener('gattserverdisconnected',()=>{ characteristic=null; setBt('off'); scheduleReconnect(); });
  const server=await device.gatt.connect();
  const service=await server.getPrimaryService(SERVICE);
  characteristic=await service.getCharacteristic(CHAR);
  await characteristic.startNotifications();
  characteristic.addEventListener('characteristicvaluechanged',onNotification);
  await initializeTrain();
  setBt('ready'); say('🚂');
}

async function connectByUser(){
  if(!('bluetooth' in navigator)){ $('unsupported').style.display='block'; return; }
  try{
    if(device?.gatt?.connected){ setBt('ready'); return; }
    setBt('connecting');
    const d=await navigator.bluetooth.requestDevice({ filters:[{services:[SERVICE]}], optionalServices:[SERVICE] });
    await attachDevice(d);
  }catch(e){ setBt('off'); if(e?.name!=='NotFoundError') say('Bluetooth lukt nog niet'); console.warn(e); }
}

async function autoReconnect(){
  if(!('bluetooth' in navigator) || !navigator.bluetooth.getDevices) return;
  try{
    const ds=await navigator.bluetooth.getDevices();
    if(ds.length) await attachDevice(ds[0]);
  }catch(e){ console.warn('auto reconnect',e); }
}
function scheduleReconnect(){ clearTimeout(reconnectTimer); reconnectTimer=setTimeout(async()=>{ try{ if(device) await attachDevice(device); }catch(e){ scheduleReconnect(); } },1800); }

function onNotification(ev){
  const v=ev.target.value; const data=new Uint8Array(v.buffer,v.byteOffset,v.byteLength);
  if(data.length<5 || data[2]!==0x45 || data[3]!==PORT_COLOR) return;
  let c=data[4]; if(c===1 || c===5) c+=1;
  pendingColor=c; clearTimeout(colorTimer); colorTimer=setTimeout(handleSettledColor,250);
}
function handleSettledColor(){
  const c=pendingColor, now=Date.now();
  if(![COLORS.RED,COLORS.YELLOW,COLORS.GREEN,COLORS.WHITE,COLORS.BLUE].includes(c)){ lastHandledColor=-1; return; }
  if(c===lastHandledColor && now-lastHandledColorMs<1500) return;
  lastHandledColor=c; lastHandledColorMs=now; railAction(c);
}
async function railAction(c){
  clearTimeout(blueResumeTimer);
  if(c===COLORS.RED){ await sound(SOUND_BRAKE); await setSpeed(0,true); }
  else if(c===COLORS.YELLOW){ await sound(SOUND_HORN); }
  else if(c===COLORS.GREEN){ const rev=currentSpeed===0?-40:-currentSpeed; await setSpeed(0,true); setTimeout(()=>setSpeed(rev,true),180); }
  else if(c===COLORS.WHITE){ await setLamp(lampColor===COLORS.WHITE?COLORS.BLACK:COLORS.WHITE); }
  else if(c===COLORS.BLUE){ const resume=currentSpeed; await setSpeed(0,true); await sound(SOUND_WATER); blueResumeTimer=setTimeout(()=>setSpeed(resume,true),1650); }
}

// Child-friendly controls.
speedInput.addEventListener('input',()=>setKnob(speedInput.value));
speedInput.addEventListener('change',()=>{ clearTimeout(blueResumeTimer); setSpeed(Number(speedInput.value)); });
let dragTimer=null;
speedInput.addEventListener('input',()=>{ clearTimeout(dragTimer); dragTimer=setTimeout(()=>setSpeed(Number(speedInput.value)),90); });
$('horn').addEventListener('pointerdown',e=>{ e.preventDefault(); sound(SOUND_HORN); });
$('stop').addEventListener('pointerdown',e=>{ e.preventDefault(); clearTimeout(blueResumeTimer); setSpeed(0); sound(SOUND_BRAKE); });
$('frontLamp').addEventListener('pointerdown',e=>{ e.preventDefault(); cycleLamp(); });
$('chimneyLamp').addEventListener('pointerdown',e=>{ e.preventDefault(); cycleLamp(); });
$('bt').addEventListener('click',connectByUser);
$('home').addEventListener('click',connectByUser);

// Prevent the device from keeping a nonzero speed command when the page gets hidden.
document.addEventListener('visibilitychange',()=>{ if(document.hidden && characteristic) setSpeed(0); });
window.addEventListener('pagehide',()=>{ if(characteristic) setSpeed(0); });

setKnob(0); setLampVisual(COLORS.BLACK); setBt('off');
if(!('bluetooth' in navigator)) $('unsupported').style.display='block';
else setTimeout(autoReconnect,600);
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
