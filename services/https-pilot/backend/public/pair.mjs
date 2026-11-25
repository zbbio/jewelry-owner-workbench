const form=document.getElementById('n15-pair'), field=form.elements.code, status=document.getElementById('state'), button=form.querySelector('button');
form.addEventListener('submit',async e=>{
  e.preventDefault();if(button.disabled)return;button.disabled=true;
  try{const r=await fetch('/api/pair',{method:'POST',mode:'same-origin',credentials:'same-origin',redirect:'error',
    referrerPolicy:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:field.value,nonce:form.elements.nonce.value})});
    const x=await r.json();if(r.ok&&x.paired===true){field.value='';location.replace('/');return;}
    status.textContent=x.error?.message||'配对未确认。';if(r.status===401)field.value='';
  }catch{status.textContent='未确认配对结果，请联系本店操作员，不要重复领码。';}
  finally{button.disabled=false;}
});
