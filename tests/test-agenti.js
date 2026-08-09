// tests/test-agenti.js — Scegliere un agente deve cambiare qualcosa.
//
// PERCHE' ESISTE
// Il menu in alto elencava quattro agenti e la scelta non produceva alcun
// effetto: /api/agenti/scegli scriveva ctx._agenteScelto e l'unico a rileggerlo
// era l'endpoint che lo ristampava. Voce, lingua e carattere restavano quelli di
// COBRA. Un menu che non cambia niente e' peggio di un menu che non c'e':
// sembra funzionare.

// Prova che scegliere un agente cambia davvero qualcosa.
const path=require('path').join(__dirname,'..');
const sm=require(path+'/modules/supermario');
const {COBRA_TOOLS}=require(path+'/modules/tools/schemas');
const {elenco,quello}=require(path+'/modules/config/agenti');
let p=0,f=0; const ok=(n,c,d='')=>{c?(p++,console.log('  ✓ '+n)):(f++,console.log('  ✗ '+n+(d?' — '+d:'')));};
(async()=>{
  console.log('\n── La scelta dell\'agente arriva nel prompt? ──');
  const msg='fammi un riassunto';
  const r=sm.routeIntent(msg);
  const fai=async(ctx)=>(await sm.assemble({intent:r.intent,scopes:r.scopes,operationLevel:r.operationLevel,
    userMessage:msg,conversationHistory:[],lastToolResult:null,voiceMode:false,allTools:COBRA_TOOLS,ctx})).systemPrompt;

  // ── Senza scelta parla COBRA, non "nessuno" ──
  //
  // Questa prova pretendeva che senza scelta esplicita il prompt NON nominasse
  // nessun agente. Era il comportamento che il 9 agosto faceva dire a Luca
  // "il collega non usa l'agente cobra": con ctx._agenteScelto vuoto — cioe'
  // quasi sempre, perche' la scelta non sopravviveva ai riavvii — il carattere
  // di COBRA non entrava nel prompt e la voce cadeva su una costante che non
  // appartiene a nessuno dei quattro agenti.
  //
  // Non esiste il caso "nessun agente": o parla COBRA, o parla uno degli altri.
  const base=await fai({});
  ok('senza scelta parla comunque COBRA', /CHI SEI ADESSO: COBRA/.test(base));
  ok('e nella sua lingua', /italiano/.test(base));

  for (const a of elenco().filter(x=>!x.predefinito)) {
    const t=await fai({_agenteScelto:a.id});
    ok(`${a.nome}: entra nel prompt`, t.includes('CHI SEI ADESSO: '+a.nome));
    ok(`${a.nome}: impone la sua lingua`, new RegExp('Rispondi SEMPRE in').test(t));
    ok(`${a.nome}: porta il suo carattere`, t.includes(a.carattere.slice(0,30)));
  }
  console.log('\n── E ogni agente ha una voce diversa ──');
  const voci=elenco().map(a=>a.voce);
  ok('quattro voci distinte', new Set(voci).size===voci.length, voci.join(', '));
  ok('quello() torna il predefinito su id sconosciuto', quello('xxx').predefinito===true);
  console.log(`\n  ${p} PASS, ${f} FAIL\n`); process.exit(f?1:0);
})();
