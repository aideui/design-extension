console.log('csp script ran');
document.getElementById('go').onclick=()=>{ fetch('/csp-missing').then(r=>console.warn('csp fetch',r.status)); document.querySelector('p').textContent='clicked'; };
