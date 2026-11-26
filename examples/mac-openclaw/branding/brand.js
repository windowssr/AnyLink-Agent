// Cosmetic adapter for the pinned Control UI. Never reads messages, credentials,
// inputs, fetch responses or local storage, and never changes tool controls.
const resource=new URL('./',import.meta.url),version=new URL(import.meta.url).searchParams.get('v')??'1';
const asset=name=>{const url=new URL(name,resource);url.searchParams.set('v',version);return url.href;};
const portrait=asset('avatar.png');
const containers='.sidebar-workspace-header__mark,.sidebar-brand__icon,.sidebar-agent-card__avatar,openclaw-theme-brand-icon,openclaw-mascot,.login-gate__logo--neutral,.chat-avatar.assistant:not(img)';
function sameAttribute(element,name,value){if(element.getAttribute(name)!==value)element.setAttribute(name,value);}
export function brandedTitle(title){
  if(/^OpenClaw(?: Control)?$/.test(title))return '大肥鱼 · AnyLink';
  return title.replace(/(\s[—–|·]\s*)OpenClaw(?: Control)?$/,'$1大肥鱼');
}
function paint(root){
  for(const image of root.querySelectorAll('img.topbar-brand__logo,img.login-gate__logo,img.chat-avatar.assistant')){sameAttribute(image,'src',portrait);sameAttribute(image,'alt','大肥鱼');if(!image.classList.contains('anylink-brand-avatar'))image.classList.add('anylink-brand-avatar');}
  for(const element of root.querySelectorAll(containers)){
    if(!element.classList.contains('anylink-brand-portrait'))element.classList.add('anylink-brand-portrait');
  }
  for(const element of root.querySelectorAll('.topbar-brand__title,.login-gate__title'))if(/^OpenClaw(?: Control)?$/.test(element.textContent.trim()))element.textContent='大肥鱼';
  for(const element of root.querySelectorAll('.topbar-brand[aria-label="OpenClaw"]'))sameAttribute(element,'aria-label','大肥鱼');
}
function refresh(){
  paint(document);
  const title=brandedTitle(document.title);if(document.title!==title)document.title=title;
}
if(typeof document!=='undefined'){
  // A stylesheet overlay avoids touching reactive custom-element children.
  // Bounded polling also avoids fighting the UI's own title/favicon observers.
  document.documentElement.style.setProperty('--anylink-brand-portrait',`url("${portrait}")`);
  refresh();
  setInterval(refresh,1000);
}
