import fs from 'node:fs';
import path from 'node:path';
// Target fencing is independent of model instructions and never builds shell text.
const protectedApps=new Set(['com.anylink.desktop','boo.peekaboo.mac','com.apple.systempreferences','com.apple.Terminal','com.googlecode.iterm2','com.apple.ScriptEditor2','com.apple.Automator','com.openai.codex','com.anysphere.sand','com.anthropic.claudefordesktop','com.apple.Passwords','com.apple.keychainaccess'].map(id=>id.toLowerCase()));
export function validateApp(app){
  if(typeof app!=='string'||app.length>160||!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(app))throw new Error('APP_BUNDLE_ID_REQUIRED');
  if(protectedApps.has(app.toLowerCase())||/anylink|peekaboo/i.test(app))throw new Error('PROTECTED_APP_USE_HUMAN_OR_APPROVED_EXEC');
  return app;
}
export function workspaceDocument(workspace,relative){
  if(typeof relative!=='string'||!relative||relative.length>1000||path.isAbsolute(relative))throw new Error('WORKSPACE_RELATIVE_FILE_REQUIRED');
  const base=fs.realpathSync(workspace),file=fs.realpathSync(path.resolve(base,relative));
  if(!file.startsWith(base+path.sep)||!fs.statSync(file).isFile())throw new Error('FILE_OUTSIDE_WORKSPACE');
  return file;
}
export function actionArguments(input,observation){
  if(!observation||observation.used||Date.now()-observation.created>45000)throw new Error('FRESH_OBSERVATION_REQUIRED');
  if(input.app!==observation.app)throw new Error('OBSERVATION_APP_MISMATCH');
  if(observation.protectedSurface)throw new Error('OWN_APPROVAL_SURFACE_REQUIRES_HUMAN');
  if(observation.focusedSecure&&['type','key'].includes(input.action))throw new Error('SECURE_FIELD_REQUIRES_HUMAN');
  validateApp(input.app);
  const target=['--app',input.app,'--window-id',String(observation.windowId),'--snapshot',observation.snapshotId];
  const coordinate=(x,y)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=observation.width||y>=observation.height)throw new Error('COORDINATE_OUT_OF_OBSERVATION');
    return `${Math.floor(x*observation.scaleX)},${Math.floor(y*observation.scaleY)}`;
  };
  let args;
  if(input.action==='focus'){
    // Focus accepts the exact observed window selector. Peekaboo's focus path
    // cannot resolve a remote producer's ps1 snapshot as local window metadata.
    return ['window','focus','--app',input.app,'--window-id',String(observation.windowId),'--space-switch','--verify'];
  }else if(input.action==='click'){
    args=['click',...target];
    if(input.element_id){if(!observation.elements.has(input.element_id))throw new Error('UNKNOWN_ELEMENT');args.push('--on',input.element_id);}
    else args.push('--at',coordinate(input.x,input.y));
    if(input.button==='right')args.push('--right');
    if(input.double===true)args.push('--double');
  }else if(input.action==='type'){
    if(typeof input.text!=='string'||input.text.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text))throw new Error('INVALID_TEXT');
    if(input.foreground===true){
      // An empty paste payload must never fall back to the user's clipboard.
      if(!input.text.trim())throw new Error('EMPTY_FOREGROUND_TEXT_USE_EXPLICIT_DELETE_KEY');
      // A clipboard transaction preserves Unicode under a Chinese input method.
      // Peekaboo owns restore and preserves any newer user clipboard change.
      args=['paste','--text',input.text,'--app',input.app,'--window-id',String(observation.windowId),'--restore-delay','300ms'];
    }else{
      args=['type','--text',input.text.replaceAll('\\','\\\\'),...target];if(input.clear===true)args.push('--clear');
    }
  }else if(input.action==='key'){
    if(typeof input.key!=='string'||!/^(?:(?:cmd|command|ctrl|control|shift|alt|option|fn)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|return|enter|tab|escape|esc|delete|backspace|forwarddelete|space|up|down|left|right|home|end|pageup|pagedown|[,.\-])$/i.test(input.key)||input.key.length>80)throw new Error('INVALID_KEY');
    args=['press','--key',input.key,...target];
  }else if(input.action==='scroll'){
    if(!['up','down','left','right'].includes(input.direction))throw new Error('INVALID_SCROLL');
    const amount=input.amount??3;if(!Number.isInteger(amount)||amount<1||amount>20)throw new Error('INVALID_SCROLL');
    args=['scroll','--direction',input.direction,'--amount',String(amount),...target];
    if(input.element_id){if(!observation.elements.has(input.element_id))throw new Error('UNKNOWN_ELEMENT');args.push('--on',input.element_id);}
    else args.push('--at',coordinate(input.x,input.y));
  }else if(input.action==='drag'){
    // Element drag avoids mixing screenshot-local and global desktop coordinates.
    if(!observation.elements.has(input.element_id)||!observation.elements.has(input.to_element_id))throw new Error('DRAG_REQUIRES_OBSERVED_ELEMENTS');
    args=['drag','--from',input.element_id,'--to',input.to_element_id,'--duration','600ms',...target];
  }else throw new Error('UNSUPPORTED_ACTION');
  if(input.foreground===true)args.push('--foreground','--space-switch');
  return args;
}
