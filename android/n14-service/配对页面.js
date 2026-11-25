'use strict';
const field=document.getElementById('code');
const form=document.getElementById('n14-pair');
const alertBox=document.getElementById('pair-status');
const button=form.querySelector('button');
form.addEventListener('submit',async e=>{
  e.preventDefault();if(button.disabled)return;
  button.disabled=true;alertBox.textContent='正在核对配对…';
  try{
    const r=await fetch('/api/pair',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',
      referrerPolicy:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:field.value,nonce:form.elements.nonce.value})});
    const data=await r.json();
    if(r.ok&&data.paired===true){field.value='';location.replace('/');return;}
    if(r.status===401)field.value='';
    alertBox.textContent=data.error?.message||'配对未完成；请让电脑操作员先核对状态。';
  }catch{alertBox.textContent='未确认配对结果；请让电脑操作员核对，不要重复领码。';}
  finally{button.disabled=false;}
});
