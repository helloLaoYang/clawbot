export const adminPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clawbot 管理</title><style>
body{font-family:ui-sans-serif,system-ui;max-width:680px;margin:48px auto;padding:0 20px;color:#17202a}main{display:grid;gap:16px}
section{border:1px solid #dfe6e9;border-radius:12px;padding:20px}input,textarea,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #b2bec3}
textarea{display:block;box-sizing:border-box;width:100%;min-height:110px;margin:8px 0 16px;resize:vertical}button{background:#1677ff;color:white;border:0;cursor:pointer}pre{white-space:pre-wrap;background:#f5f6fa;padding:12px;border-radius:8px}img{max-width:280px}
</style></head><body><main><h1>Clawbot 管理</h1>
<section><label>管理 Token <input id="token" type="password" autocomplete="off"></label> <button id="save">保存到本标签页</button></section>
<section><button id="status">刷新状态</button> <button id="login">开始/重新扫码</button><pre id="out">尚未查询</pre><div id="qr"></div></section>
<section id="verify" hidden><label>验证码 <input id="code" inputmode="numeric"></label> <button id="submitCode">提交验证码</button></section>
<section><h2>全局 AI 设置</h2>
<label>人设<textarea id="persona" maxlength="20000" placeholder="例如：你叫小爪，是一名冷静、友善的技术助理。"></textarea></label>
<label>个性化偏好<textarea id="personalization" maxlength="20000" placeholder="例如：默认使用简体中文，先给结论，回答尽量简洁。"></textarea></label>
<button id="loadSettings">读取设置</button> <button id="saveSettings">保存设置</button><pre id="settingsOut">尚未读取</pre></section>
</main><script>
const token=document.querySelector('#token'),out=document.querySelector('#out'),qr=document.querySelector('#qr'),verify=document.querySelector('#verify'),persona=document.querySelector('#persona'),personalization=document.querySelector('#personalization'),settingsOut=document.querySelector('#settingsOut');
token.value=sessionStorage.getItem('adminToken')||'';let sessionId=null,timer=null;
const request=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'Authorization':'Bearer '+sessionStorage.getItem('adminToken'),...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||response.statusText);return data};
document.querySelector('#save').onclick=()=>{sessionStorage.setItem('adminToken',token.value);out.textContent='Token 已保存到 sessionStorage'};
document.querySelector('#status').onclick=async()=>{try{out.textContent=JSON.stringify(await request('/api/admin/status'),null,2)}catch(e){out.textContent=e.message}};
document.querySelector('#loadSettings').onclick=async()=>{try{const s=await request('/api/admin/settings');persona.value=s.persona;personalization.value=s.personalization;settingsOut.textContent=s.updatedAt?'最后更新：'+s.updatedAt:'尚未配置'}catch(e){settingsOut.textContent=e.message}};
document.querySelector('#saveSettings').onclick=async()=>{try{const s=await request('/api/admin/settings',{method:'PUT',body:JSON.stringify({persona:persona.value,personalization:personalization.value})});persona.value=s.persona;personalization.value=s.personalization;settingsOut.textContent='已保存：'+s.updatedAt}catch(e){settingsOut.textContent=e.message}};
const show=s=>{out.textContent=JSON.stringify(s,null,2);verify.hidden=!s.requiresVerifyCode;if(s.qrcodeUrl){qr.innerHTML='';const img=new Image();img.alt='微信扫码登录';img.src=s.qrcodeUrl;img.onerror=()=>{qr.textContent='请打开此地址完成扫码：'+s.qrcodeUrl};qr.appendChild(img)}if(['confirmed','expired','error','verify_code_blocked'].includes(s.status))clearInterval(timer)};
document.querySelector('#login').onclick=async()=>{try{const s=await request('/api/admin/weixin/login-sessions',{method:'POST',body:'{}'});sessionId=s.id;show(s);clearInterval(timer);timer=setInterval(async()=>{try{show(await request('/api/admin/weixin/login-sessions/'+sessionId))}catch(e){out.textContent=e.message}},1500)}catch(e){out.textContent=e.message}};
document.querySelector('#submitCode').onclick=async()=>{try{show(await request('/api/admin/weixin/login-sessions/'+sessionId+'/verify-code',{method:'POST',body:JSON.stringify({code:document.querySelector('#code').value})}))}catch(e){out.textContent=e.message}};
</script></body></html>`;
