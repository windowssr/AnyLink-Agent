window.anylinkMobileAvatar={update(v){
 const allowed=['idle','listening','thinking','working','speaking','attention'];
 document.body.className=[allowed.includes(v?.phase)?v.phase:'idle',v?.paused?'paused':'',v?.reducedMotion?'reduced':''].join(' ');
 document.body.style.clipPath=`inset(0 0 ${(Number(v?.safeBottom)||0)/(window.devicePixelRatio||1)}px 0)`;
 const top=(Number(v?.safeTop)||116)/(window.devicePixelRatio||1);
 document.querySelector('.companion').style.top=top+'px';
 document.querySelector('.companion').style.width=v?.mini?'110px':'min(66%,256px)';
 document.getElementById('mouth').setAttribute('ry',String(1.2+(v?.phase==='speaking'?Math.max(0,Math.min(1,Number(v?.level)||0))*8:0)));
 document.getElementById('head').style.transform=v?.phase==='listening'?'rotate(2deg)':'none';
 document.getElementById('head').style.transformOrigin='128px 176px';
}};
window.anylinkAvatarStatus={state:'ready',message:'公开版形象已就绪'};
console.info('ANYLINK_AVATAR_READY');
