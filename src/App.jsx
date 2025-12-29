import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, 
  addDoc, getDoc, arrayUnion 
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  Wifi, Send, Download, Copy, Smartphone, Monitor, CheckCircle, 
  FileText, Loader, QrCode, AlertCircle
} from 'lucide-react';

/**
 * BridgeLink - Robust Cross-Subnet File Transfer
 * Fixed: File transfer deadlocks, mobile latency, and connection jitter.
 */

// --- Firebase Configuration ---
// ⚠️ 必须修改：请替换为你自己的 Firebase 项目配置
const firebaseConfig = {
   apiKey: "AIzaSyD4CjObcCBweNd_iV5zXO9WHUCYqgFhyJk",
  authDomain: "bridgelink-4c01a.firebaseapp.com",
  projectId: "bridgelink-4c01a",
  storageBucket: "bridgelink-4c01a.firebasestorage.app",
  messagingSenderId: "148504358430",
  appId: "1:148504358430:web:6e836f1ef867bd3e57480f",
};

const appId = 'bridge-link-v1';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// RTC Configuration: Optimized for China
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.miwifi.com' },
    { urls: 'stun:stun.qq.com' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10,
};

// WebRTC 最佳实践：16KB 分片，既不过大导致丢包，也不过小导致 CPU 飙升
const CHUNK_SIZE = 16384; 
const BUFFER_THRESHOLD = 65536; // 64KB 高水位线
const COLLECTION_NAME = 'rooms'; 

const Header = ({ connectionStatus, setView }) => (
  <div className="bg-indigo-600 text-white p-4 shadow-md flex justify-between items-center z-10 relative">
    <div className="flex items-center gap-2" onClick={() => setView('home')}>
      <Wifi className="w-6 h-6 cursor-pointer" />
      <h1 className="text-xl font-bold cursor-pointer">BridgeLink</h1>
    </div>
    <div className={`text-xs px-2 py-1 rounded transition-colors duration-300 ${
      connectionStatus === 'connected' ? 'bg-emerald-500' : 
      connectionStatus === 'disconnected' ? 'bg-rose-500' : 'bg-indigo-700'
    }`}>
      {connectionStatus === 'connected' ? 'P2P 已加密连接' : 
       connectionStatus === 'disconnected' ? '连接已断开' : '等待连接...'}
    </div>
  </div>
);

export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('home'); 
  const [roomId, setRoomId] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); 
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [inputMsg, setInputMsg] = useState('');
  const [transferProgress, setTransferProgress] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [showQR, setShowQR] = useState(false);

  // Refs
  const peerConnection = useRef(null);
  const dataChannel = useRef(null);
  const receivedBuffers = useRef([]);
  const receivedSize = useRef(0);
  const currentFileMeta = useRef(null);
  const heartbeatInterval = useRef(null);
  const disconnectTimer = useRef(null); // 用于防抖动断连

  // --- Auth & Init ---
  useEffect(() => {
    const initAuth = async () => {
      try { await signInAnonymously(auth); } 
      catch (e) { console.error("Auth Error:", e); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam.toUpperCase());
      setView('join');
    }

    return () => {
      unsubscribe();
      cleanupConnection();
    };
  }, []);

  const cleanupConnection = () => {
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
    if (peerConnection.current) peerConnection.current.close();
    peerConnection.current = null;
    dataChannel.current = null;
  };

  // --- WebRTC Core ---

  const setupPeerConnection = async (isInitiator, activeRoomId) => {
    cleanupConnection();
      
    peerConnection.current = new RTCPeerConnection(rtcConfig);

    peerConnection.current.onicecandidate = async (event) => {
      if (event.candidate && auth.currentUser) {
        const field = isInitiator ? 'callerCandidates' : 'calleeCandidates';
        const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, activeRoomId);
        try {
          await updateDoc(roomRef, { [field]: arrayUnion(event.candidate.toJSON()) });
        } catch (e) { /* ignore auth errors on tear down */ }
      }
    };

    peerConnection.current.onconnectionstatechange = () => {
      const state = peerConnection.current?.connectionState;
      console.log("Connection State:", state);
      
      if (state === 'connected') {
        if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
        setConnectionStatus('connected');
        setShowQR(false);
      } else if (state === 'disconnected' || state === 'failed') {
        // 防抖动：延迟 3 秒显示断开，给网络抖动留出恢复时间
        if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
        disconnectTimer.current = setTimeout(() => {
          setConnectionStatus('disconnected');
          addSystemMessage("连接已断开，正在尝试恢复...");
        }, 3000);
      }
    };

    if (isInitiator) {
      const dc = peerConnection.current.createDataChannel("chat", { negotiated: true, id: 0 });
      setupDataChannel(dc);
      
      const offer = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offer);

      const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, activeRoomId);
      await updateDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp } });
    } else {
      const dc = peerConnection.current.createDataChannel("chat", { negotiated: true, id: 0 });
      setupDataChannel(dc);
    }
  };

  const setupDataChannel = (dc) => {
    dataChannel.current = dc;
    // 设置缓冲阈值，配合 sendFile 使用
    dc.bufferedAmountLowThreshold = CHUNK_SIZE;

    dc.onopen = () => {
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
      setConnectionStatus('connected');
      setShowQR(false); 
      addSystemMessage("通道就绪，可以开始传输");
      startHeartbeat();
    };

    dc.onclose = () => {
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    };

    dc.onmessage = handleDataChannelMessage;
  };

  const startHeartbeat = () => {
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    heartbeatInterval.current = setInterval(() => {
      // 只有在空闲时发送心跳，防止阻塞文件流
      if (dataChannel.current?.readyState === 'open' && dataChannel.current.bufferedAmount === 0) {
        try { dataChannel.current.send(JSON.stringify({ type: 'ping' })); } catch(e){}
      }
    }, 3000);
  };

  const handleDataChannelMessage = (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') return;
        if (msg.type === 'text') {
          setMessages(p => [...p, { sender: 'peer', text: msg.content, time: new Date() }]);
        } else if (msg.type === 'file-meta') {
          currentFileMeta.current = msg;
          receivedBuffers.current = [];
          receivedSize.current = 0;
          setTransferProgress(0);
          addSystemMessage(`正在接收: ${msg.name} (${formatBytes(msg.size)})`);
        } else if (msg.type === 'file-end') {
          saveReceivedFile();
        }
      } catch (e) {}
    } else {
      // 接收二进制分片
      receivedBuffers.current.push(data);
      receivedSize.current += data.byteLength;
      if (currentFileMeta.current) {
        setTransferProgress(Math.round((receivedSize.current / currentFileMeta.current.size) * 100));
      }
    }
  };

  const saveReceivedFile = () => {
    const blob = new Blob(receivedBuffers.current);
    const url = URL.createObjectURL(blob);
    const meta = currentFileMeta.current;
    setFiles(p => [...p, { name: meta.name, size: meta.size, url, sender: 'peer' }]);
    addSystemMessage(`接收完成: ${meta.name}`);
    receivedBuffers.current = [];
    currentFileMeta.current = null;
    setTransferProgress(0);
  };

  // --- Firestore Listeners ---

  const createRoom = async () => {
    if (!user) return;
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(id);
    setView('session');
    setConnectionStatus('connecting');
    setShowQR(true); 

    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, id);
    await setDoc(roomRef, { created: Date.now(), callerCandidates: [], calleeCandidates: [] });

    await setupPeerConnection(true, id);

    onSnapshot(roomRef, async (s) => {
      const d = s.data();
      if (!d) return;
      
      // Handle Answer
      if (peerConnection.current?.signalingState === 'have-local-offer' && d.answer) {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(d.answer));
      }
      
      // Handle Candidates
      if (d.calleeCandidates) {
        d.calleeCandidates.forEach(async c => {
           try { await peerConnection.current.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
        });
      }
    });
  };

  const joinRoom = async (id) => {
    if (!user || !id) return;
    setRoomId(id);
    setView('session');
    setConnectionStatus('connecting');

    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, id);
    const snap = await getDoc(roomRef);

    if (snap.exists()) {
      await setupPeerConnection(false, id);
      const data = snap.data();
      
      if (data.offer) {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.current.createAnswer();
        await peerConnection.current.setLocalDescription(answer);
        await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });
      }

      onSnapshot(roomRef, (s) => {
        const d = s.data();
        if (d?.callerCandidates) {
          d.callerCandidates.forEach(async c => {
             try { await peerConnection.current.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
          });
        }
      });
    } else {
      alert("房间不存在");
      setView('home');
    }
  };

  // --- Actions ---

  const sendMessage = () => {
    if (!inputMsg.trim() || !dataChannel.current) return;
    if (dataChannel.current.readyState !== 'open') {
        alert("连接中，请稍后...");
        return;
    }
    const msg = { type: 'text', content: inputMsg };
    dataChannel.current.send(JSON.stringify(msg));
    setMessages(p => [...p, { sender: 'me', text: inputMsg, time: new Date() }]);
    setInputMsg('');
  };

  /**
   * 核心修复：高性能文件发送逻辑
   * 使用递归 + bufferedAmountLow 事件，彻底解决卡顿和死锁问题
   */
  const sendFile = async (file) => {
    if (!dataChannel.current || isSending) return;
    const dc = dataChannel.current;
    if (dc.readyState !== 'open') return alert("连接断开");

    setIsSending(true);
    
    // 1. 发送元数据
    dc.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, fileType: file.type }));

    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      if (dc.readyState !== 'open') { setIsSending(false); return; }
      
      try {
        dc.send(e.target.result);
        offset += e.target.result.byteLength;
        setTransferProgress(Math.min(100, Math.round((offset / file.size) * 100)));

        if (offset < file.size) {
          // 流控核心：如果缓冲区满了，等待 bufferedamountlow 事件再继续
          if (dc.bufferedAmount > BUFFER_THRESHOLD) {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null; // 清除监听，防止泄漏
              readNextChunk();
            };
          } else {
            // 缓冲区未满，直接读下一块
            readNextChunk();
          }
        } else {
          // 发送完成
          dc.send(JSON.stringify({ type: 'file-end' }));
          setFiles(p => [...p, { name: file.name, size: file.size, sender: 'me' }]);
          addSystemMessage(`文件发送完成: ${file.name}`);
          setIsSending(false);
          setTransferProgress(0);
        }
      } catch (err) {
        console.error("Send Error:", err);
        setIsSending(false);
        alert("发送出错");
      }
    };

    readNextChunk();
  };

  // --- Helpers ---
  
  const addSystemMessage = (text) => setMessages(p => [...p, { sender: 'system', text, time: new Date() }]);
  
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const copyLink = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => alert("已复制")).catch(() => alert("复制失败"));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position="fixed"; 
      document.body.appendChild(ta); 
      ta.focus(); ta.select();
      document.execCommand('copy'); 
      document.body.removeChild(ta);
      alert("已复制");
    }
  };

  const getJoinUrl = () => {
    const u = new URL(window.location.href);
    u.searchParams.set('room', roomId);
    return u.toString();
  };

  if (!user) return <div className="h-screen flex items-center justify-center"><Loader className="animate-spin text-indigo-600 w-10 h-10" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col">
      <Header connectionStatus={connectionStatus} setView={setView} />

      <main className="flex-grow p-4 max-w-lg mx-auto w-full relative">
        {view === 'home' && (
          <div className="space-y-6 mt-10">
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-bold text-slate-900">跨网段文件互传</h2>
              <p className="text-slate-500 text-sm">无需同一 WiFi，支持 4G/5G 跨网直连</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <button onClick={createRoom} className="flex flex-col items-center p-6 bg-white rounded-xl shadow-sm border hover:border-indigo-500">
                <Monitor className="w-8 h-8 text-indigo-600 mb-2" />
                <span className="font-semibold">创建连接</span>
              </button>
              <button onClick={() => setView('join')} className="flex flex-col items-center p-6 bg-white rounded-xl shadow-sm border hover:border-emerald-500">
                <Smartphone className="w-8 h-8 text-emerald-600 mb-2" />
                <span className="font-semibold">加入连接</span>
              </button>
            </div>
          </div>
        )}

        {view === 'join' && (
          <div className="mt-10 bg-white p-6 rounded-xl shadow-sm border">
            <h3 className="text-lg font-bold mb-4">输入连接码</h3>
            <input type="text" placeholder="XXXXXX" className="w-full text-center text-2xl tracking-widest uppercase border-2 rounded-lg p-3 mb-4"
              value={roomId} onChange={(e) => setRoomId(e.target.value.toUpperCase())} />
            <div className="flex gap-3">
              <button onClick={() => setView('home')} className="flex-1 py-3 bg-slate-100 rounded-lg">返回</button>
              <button onClick={() => joinRoom(roomId)} disabled={roomId.length < 4} className="flex-1 py-3 bg-indigo-600 text-white rounded-lg disabled:opacity-50">连接</button>
            </div>
          </div>
        )}

        {view === 'session' && (
          <div className="flex flex-col h-[calc(100vh-120px)]">
            <div className="bg-white p-4 rounded-xl shadow-sm border mb-4 flex justify-between items-center relative">
              <div>
                <p className="text-xs text-slate-400 font-bold">ROOM ID</p>
                <p className="text-2xl font-mono font-bold">{roomId}</p>
              </div>
              <div className="flex gap-2">
                 <button onClick={() => setShowQR(!showQR)} className="p-2 bg-slate-100 rounded-full"><QrCode size={18}/></button>
                 <button onClick={() => copyLink(roomId)} className="p-2 bg-slate-100 rounded-full"><Copy size={18}/></button>
              </div>
              
              {showQR && (
                <div className="absolute top-full left-0 right-0 mt-2 z-20 flex flex-col items-center bg-white p-6 rounded-xl shadow-xl border">
                  <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(getJoinUrl())}`} className="w-48 h-48 mb-2" alt="QR" />
                  <p className="text-xs text-slate-500 mb-3">使用手机浏览器扫描</p>
                  <button onClick={() => copyLink(getJoinUrl())} className="w-full py-2 bg-slate-100 rounded text-xs">复制链接</button>
                </div>
              )}
            </div>

            <div className="flex-grow bg-slate-100 rounded-xl mb-4 p-4 overflow-y-auto space-y-3 shadow-inner">
              {messages.length === 0 && <div className="text-center text-slate-400 mt-10">等待连接...</div>}
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.sender === 'me' ? 'justify-end' : msg.sender === 'system' ? 'justify-center' : 'justify-start'}`}>
                  {msg.sender === 'system' ? 
                    <span className="text-xs bg-slate-200 text-slate-600 px-2 py-1 rounded-full">{msg.text}</span> : 
                    <div className={`max-w-[80%] p-3 rounded-lg text-sm ${msg.sender === 'me' ? 'bg-indigo-600 text-white' : 'bg-white shadow-sm'}`}>{msg.text}</div>
                  }
                </div>
              ))}
            </div>

            {transferProgress > 0 && (
               <div className="mb-4 bg-white p-3 rounded-lg border">
                 <div className="flex justify-between text-xs mb-1"><span>传输中...</span><span>{transferProgress}%</span></div>
                 <div className="w-full bg-slate-100 rounded-full h-2">
                   <div className="bg-indigo-600 h-2 rounded-full transition-all duration-300" style={{ width: `${transferProgress}%` }}></div>
                 </div>
               </div>
            )}

            {files.length > 0 && (
              <div className="mb-4 space-y-2 max-h-32 overflow-y-auto">
                 {files.map((f, i) => (
                   <div key={i} className="flex justify-between p-3 bg-white border rounded-lg">
                     <div className="flex gap-2 overflow-hidden items-center">
                       <FileText className="text-indigo-500 flex-shrink-0" />
                       <div className="truncate text-sm">{f.name} <span className="text-xs text-slate-400 ml-1">{formatBytes(f.size)}</span></div>
                     </div>
                     {f.sender === 'peer' && <a href={f.url} download={f.name} className="text-emerald-600"><Download size={18}/></a>}
                   </div>
                 ))}
              </div>
            )}

            <div className="flex gap-2">
              <label className={`p-3 rounded-lg flex items-center justify-center cursor-pointer ${isSending || connectionStatus !== 'connected' ? 'bg-slate-200 text-slate-400' : 'bg-slate-800 text-white'}`}>
                <FileText size={20} />
                <input type="file" className="hidden" disabled={isSending || connectionStatus !== 'connected'} onChange={(e) => e.target.files[0] && sendFile(e.target.files[0])} />
              </label>
              <input type="text" value={inputMsg} onChange={(e) => setInputMsg(e.target.value)} disabled={connectionStatus !== 'connected'} className="flex-grow p-3 rounded-lg border" placeholder="输入消息..." onKeyDown={(e)=>e.key==='Enter'&&sendMessage()} />
              <button onClick={sendMessage} disabled={connectionStatus !== 'connected'} className="p-3 bg-indigo-600 text-white rounded-lg disabled:opacity-50"><Send size={20} /></button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}