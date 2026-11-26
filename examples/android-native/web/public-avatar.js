// Original, code-native placeholder. No third-party model, texture or Cubism Core.
window.anylinkMobileAvatar={update(v){const allowed=['idle','listening','thinking','working','speaking','attention'];document.body.className=[allowed.includes(v?.phase)?v.phase:'idle',v?.paused?'paused':'',v?.reducedMotion?'reduced':''].join(' ');}};
console.info('ANYLINK_AVATAR_READY');
