import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { ensureClientSession } from './mosa-api'

// 任务 314：读接口也要凭据，缩略图走 <img> 只能靠 cookie。渲染之前先把
// 「凭据 → POST /api/client-session → HttpOnly cookie」这一步做完（桌面版
// 经 IPC 领凭据，浏览器/源码模式读网址 hash）。拿不到凭据也照常渲染：
// 界面会以 401 的出错状态呈现，绝不白屏或卡死。
void ensureClientSession().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
