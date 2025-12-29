import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, 
  addDoc, getDoc, deleteDoc, arrayUnion 
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  Wifi, Send, Download, Copy, Smartphone, Monitor, CheckCircle, 
  FileText, Loader, Link as LinkIcon, QrCode 
} from 'lucide-react';

/**
 * BridgeLink - Cross-Subnet File Transfer
 * Uses Firebase Firestore for Signaling and WebRTC for P2P data transfer.
 */

// --- Firebase Configuration & Initialization ---
// ⚠️ 必须修改：请替换为你自己的 Firebase 项目配置
const firebaseConfig = {
   apiKey: "AIzaSyD4CjObcCBweNd_iV5zXO9WHUCYqgFhyJk",
  authDomain: "bridgelink-4c01a.firebaseapp.com",
  projectId: "bridgelink-4c01a",
  storageBucket: "bridgelink-4c01a.firebasestorage.app",
  messagingSenderId: "148504358430",
  appId: "1:148504358430:web:6e836f1ef867bd3e57480f",
};

// 你可以自定义应用ID，用于区分数据库中的数据路径
const appId = 'bridge-link-v1';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// RTC Configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.miwifi.com' },
    { urls: 'stun:stun.qq.com' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ],
};

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const COLLECTION_NAME = 'rooms'; 

// --- 提取 Header 组件到外部，避免 React 渲染错误 ---
const Header = ({ connectionStatus, setView }) => (
  <div className="bg-indigo-600 text-white p-4 shadow-md flex justify-between items-center z-10 relative">
    <div className="flex items-center gap-2" onClick={() => setView('home')}>
      <Wifi className="w-6 h-6 cursor-pointer" />
      <h1 className="text-xl font-bold cursor-pointer">BridgeLink</h1>
    </div>
    <div className="text-xs bg-indigo-700 px-2 py-1 rounded">
      {connectionStatus === 'connected' ? 'P2P 已加密连接' : '等待连接...'}
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
  const processedCandidates = useRef(new Set()); 
  const heartbeatInterval = useRef(null); // 用于保持 NAT 连接的心跳定时器

  // --- Auth & URL Params ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Auth Error:", error);
      }
    };
    initAuth();
    
    const unsubscribe = onAuthStateChanged(auth, (u) => setUser(u));

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam.toUpperCase());
      setView('join');
    }

    return () => {
      unsubscribe();
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    };
  }, []);

  // --- WebRTC Logic ---

  const setupPeerConnection = async (isInitiator, activeRoomId) => {
    if (peerConnection.current) {
        peerConnection.current.close();
    }
    if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
    }
      
    peerConnection.current = new RTCPeerConnection(rtcConfig);
    processedCandidates.current.clear();

    peerConnection.current.onicecandidate = async (event) => {
      if (event.candidate && auth.currentUser) {
        const candidateField = isInitiator ? 'callerCandidates' : 'calleeCandidates';
        const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, activeRoomId);
        try {
          await updateDoc(roomRef, {
            [candidateField]: arrayUnion(event.candidate.toJSON())
          });
        } catch (e) {
          console.error("Error adding candidate:", e);
        }
      }
    };

    peerConnection.current.onconnectionstatechange = () => {
      console.log("Connection state:", peerConnection.current.connectionState);
      if (peerConnection.current.connectionState === 'connected') {
        setConnectionStatus('connected');
        setShowQR(false); 
      } else if (peerConnection.current.connectionState === 'disconnected' || peerConnection.current.connectionState === 'failed') {
        setConnectionStatus('disconnected');
        // 关键修复：移除 alert 弹窗，防止阻塞 JS 线程导致无法自动重连
        // 仅在 UI 上显示断开，允许底层 WebRTC 尝试恢复
        if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
      }
    };

    if (isInitiator) {
      dataChannel.current = peerConnection.current.createDataChannel("chat");
      setupDataChannel();
      
      const offer = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offer);

      if (auth.currentUser) {
        const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, activeRoomId);
        await updateDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp } });
      }
    } else {
      peerConnection.current.ondatachannel = (event) => {
        dataChannel.current = event.channel;
        setupDataChannel();
      };
    }
  };

  const setupDataChannel = () => {
    if (!dataChannel.current) return;

    dataChannel.current.onopen = () => {
      setConnectionStatus('connected');
      addSystemMessage("P2P 通道已建立！可以开始传输。");
      setShowQR(false); 

      // 关键修复：启动心跳机制，每2秒发送一次 ping，防止移动端 NAT 关闭端口
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = setInterval(() => {
        if (dataChannel.current && dataChannel.current.readyState === 'open') {
          try {
             dataChannel.current.send(JSON.stringify({ type: 'ping' }));
          } catch (e) {
             console.error("Heartbeat failed", e);
          }
        }
      }, 2000);
    };

    dataChannel.current.onclose = () => {
        if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
        setConnectionStatus('disconnected');
    };

    dataChannel.current.onmessage = handleDataChannelMessage;
  };

  const handleDataChannelMessage = (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') return; // 忽略心跳包

        if (msg.type === 'text') {
          setMessages(prev => [...prev, { sender: 'peer', text: msg.content, time: new Date() }]);
        } else if (msg.type === 'file-meta') {
          currentFileMeta.current = msg;
          receivedBuffers.current = [];
          receivedSize.current = 0;
          setTransferProgress(0);
          addSystemMessage(`正在接收文件: ${msg.name} (${formatBytes(msg.size)})...`);
        } else if (msg.type === 'file-end') {
          saveReceivedFile();
        }
      } catch (e) {
        console.error("Failed to parse message", e);
      }
    } else {
      receivedBuffers.current.push(data);
      receivedSize.current += data.byteLength;
      
      if (currentFileMeta.current) {
        const progress = Math.min(100, Math.round((receivedSize.current / currentFileMeta.current.size) * 100));
        setTransferProgress(progress);
      }
    }
  };

  const saveReceivedFile = () => {
    const blob = new Blob(receivedBuffers.current);
    const url = URL.createObjectURL(blob);
    const meta = currentFileMeta.current;
    
    setFiles(prev => [...prev, { name: meta.name, size: meta.size, url, sender: 'peer' }]);
    addSystemMessage(`文件接收完成: ${meta.name}`);
    
    receivedBuffers.current = [];
    receivedSize.current = 0;
    currentFileMeta.current = null;
    setTransferProgress(0);
  };

  // --- Firestore Signaling Listeners ---

  const createRoom = async () => {
    if (!user) return;
    const generatedId = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(generatedId);
    setView('session');
    setConnectionStatus('connecting');
    setShowQR(true); 

    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, generatedId);
    await setDoc(roomRef, { 
      created: Date.now(),
      callerCandidates: [],
      calleeCandidates: []
    });

    await setupPeerConnection(true, generatedId);

    onSnapshot(roomRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      if (!peerConnection.current.currentRemoteDescription && data.answer) {
        const answer = new RTCSessionDescription(data.answer);
        peerConnection.current.setRemoteDescription(answer);
      }

      if (data.calleeCandidates && Array.isArray(data.calleeCandidates)) {
        data.calleeCandidates.forEach(async (c) => {
           const candidateStr = JSON.stringify(c);
           if (!processedCandidates.current.has(candidateStr)) {
             processedCandidates.current.add(candidateStr);
             await peerConnection.current.addIceCandidate(new RTCIceCandidate(c));
           }
        });
      }
    });
  };

  const joinRoom = async (idToJoin) => {
    if (!user || !idToJoin) return;
    setRoomId(idToJoin);
    setView('session');
    setConnectionStatus('connecting');

    const roomRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, idToJoin);
    const roomSnapshot = await getDoc(roomRef);

    if (roomSnapshot.exists()) {
      await setupPeerConnection(false, idToJoin);
      
      const data = roomSnapshot.data();

      if(data.offer) {
          const offer = data.offer;
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
    
          const answer = await peerConnection.current.createAnswer();
          await peerConnection.current.setLocalDescription(answer);
    
          await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });
      }

      onSnapshot(roomRef, (snapshot) => {
        const newData = snapshot.data();
        if (!newData) return;

        if (newData.callerCandidates && Array.isArray(newData.callerCandidates)) {
          newData.callerCandidates.forEach(async (c) => {
             const candidateStr = JSON.stringify(c);
             if (!processedCandidates.current.has(candidateStr)) {
               processedCandidates.current.add(candidateStr);
               await peerConnection.current.addIceCandidate(new RTCIceCandidate(c));
             }
          });
        }
      });
    } else {
      alert("房间不存在，请检查代码");
      setView('home');
    }
  };

  const sendMessage = () => {
    if (!inputMsg.trim() || !dataChannel.current) return;
    const msg = { type: 'text', content: inputMsg };
    dataChannel.current.send(JSON.stringify(msg));
    setMessages(prev => [...prev, { sender: 'me', text: inputMsg, time: new Date() }]);
    setInputMsg('');
  };

  const sendFile = async (file) => {
    if (!dataChannel.current || isSending) return;
    setIsSending(true);

    const meta = { type: 'file-meta', name: file.name, size: file.size, fileType: file.type };
    dataChannel.current.send(JSON.stringify(meta));
    
    const reader = new FileReader();
    let offset = 0;

    reader.onload = async (e) => {
      if (!dataChannel.current) return;
      dataChannel.current.send(e.target.result);
      offset += e.target.result.byteLength;

      const progress = Math.min(100, Math.round((offset / file.size) * 100));
      setTransferProgress(progress);

      if (offset < file.size) {
        readSlice(offset);
      } else {
        dataChannel.current.send(JSON.stringify({ type: 'file-end' }));
        setFiles(prev => [...prev, { name: file.name, size: file.size, sender: 'me' }]);
        addSystemMessage(`文件发送完成: ${file.name}`);
        setIsSending(false);
        setTransferProgress(0);
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  };

  const addSystemMessage = (text) => {
    setMessages(prev => [...prev, { sender: 'system', text, time: new Date() }]);
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getJoinUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    return url.toString();
  };

  const copyToClipboard = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed"; 
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if(successful) alert("已复制到剪贴板");
      else alert("复制失败");
    } catch (err) {
      console.error('Unable to copy', err);
      alert("复制失败，请手动复制");
    }
    document.body.removeChild(textArea);
  };

  if (!user) return <div className="h-screen flex items-center justify-center"><Loader className="animate-spin text-indigo-600 w-10 h-10" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col">
      <Header connectionStatus={connectionStatus} setView={setView} />

      <main className="flex-grow p-4 max-w-lg mx-auto w-full relative">
        {/* VIEW: HOME */}
        {view === 'home' && (
          <div className="space-y-6 mt-10">
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-bold text-slate-900">跨网段文件互传</h2>
              <p className="text-slate-500 text-sm">
                设备无需在同一 Wifi 下。只要有互联网，即可在不同 IP、不同子网间建立直连通道。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={createRoom}
                className="flex flex-col items-center justify-center p-6 bg-white rounded-xl shadow-sm border border-slate-200 hover:border-indigo-500 hover:shadow-md transition-all group"
              >
                <div className="bg-indigo-100 p-3 rounded-full mb-3 group-hover:bg-indigo-200">
                  <Monitor className="w-8 h-8 text-indigo-600" />
                </div>
                <span className="font-semibold">创建连接</span>
                <span className="text-xs text-slate-400 mt-1">我是发送方/接收方</span>
              </button>

              <button 
                onClick={() => setView('join')}
                className="flex flex-col items-center justify-center p-6 bg-white rounded-xl shadow-sm border border-slate-200 hover:border-emerald-500 hover:shadow-md transition-all group"
              >
                <div className="bg-emerald-100 p-3 rounded-full mb-3 group-hover:bg-emerald-200">
                  <Smartphone className="w-8 h-8 text-emerald-600" />
                </div>
                <span className="font-semibold">加入连接</span>
                <span className="text-xs text-slate-400 mt-1">我有连接码</span>
              </button>
            </div>
          </div>
        )}

        {/* VIEW: JOIN */}
        {view === 'join' && (
          <div className="mt-10 bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold mb-4">输入连接码</h3>
            <input 
              type="text" 
              placeholder="例如: X7Y2Z9"
              className="w-full text-center text-2xl tracking-widest uppercase border-2 border-slate-200 rounded-lg p-3 mb-4 focus:border-indigo-500 focus:outline-none"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setView('home')} 
                className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-lg font-medium"
              >
                返回
              </button>
              <button 
                onClick={() => joinRoom(roomId)}
                disabled={roomId.length < 4}
                className="flex-1 py-3 bg-indigo-600 text-white rounded-lg font-medium disabled:opacity-50"
              >
                连接
              </button>
            </div>
          </div>
        )}

        {/* VIEW: SESSION */}
        {view === 'session' && (
          <div className="flex flex-col h-[calc(100vh-120px)]">
            
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-4 flex justify-between items-center relative">
              <div>
                <p className="text-xs text-slate-400 uppercase font-bold">当前房间</p>
                <p className="text-2xl font-mono font-bold tracking-wider text-slate-800">{roomId}</p>
              </div>
              <div className="flex items-center gap-2">
                 {/* 优化状态指示器渲染，合并 className，修复编译错误 */}
                 <div className={`flex items-center gap-1 text-sm font-medium px-2 py-1 rounded transition-colors duration-300 ${connectionStatus === 'connected' ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
                    {connectionStatus === 'connected' ? <CheckCircle size={14} /> : <Loader size={14} className="animate-spin" />}
                    <span className="hidden sm:inline">{connectionStatus === 'connected' ? '已连接' : '连接中...'}</span>
                 </div>
                 
                 <button 
                  onClick={() => setShowQR(!showQR)} 
                  className={`p-2 rounded-full transition-colors ${showQR ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 hover:bg-slate-200'}`}
                  title="显示二维码"
                 >
                   <QrCode size={18} />
                 </button>

                 <button onClick={() => copyToClipboard(roomId)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200" title="复制房间号">
                   <Copy size={18} />
                 </button>
              </div>

              {/* 使用 CSS 隐藏而不是 React 条件渲染，防止 DOM 节点丢失导致的崩溃 */}
              <div className={`absolute top-full left-0 right-0 mt-2 z-20 flex flex-col items-center bg-white p-4 rounded-xl shadow-xl border border-slate-200 transition-all duration-300 origin-top ${showQR ? 'opacity-100 scale-100 visible' : 'opacity-0 scale-95 invisible pointer-events-none'}`}>
                  <div className="bg-white p-2 rounded-lg">
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(getJoinUrl())}`} 
                      alt="Room QR Code" 
                      className="w-48 h-48"
                    />
                  </div>
                  <p className="text-xs text-slate-500 mt-2 text-center leading-relaxed">
                    使用另一台设备扫描二维码<br/>
                    <span className="text-amber-600 font-medium">注意：预览链接仅本机有效<br/>手机测试请先部署应用</span>
                  </p>
                  <div className="flex gap-2 mt-3 w-full">
                     <button 
                        onClick={() => copyToClipboard(getJoinUrl())}
                        className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 rounded text-xs font-medium"
                     >
                       复制链接
                     </button>
                     <button 
                        onClick={() => setShowQR(false)}
                        className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 rounded text-xs font-medium"
                     >
                       关闭
                     </button>
                  </div>
              </div>
            </div>

            <div className="flex-grow bg-slate-100 rounded-xl mb-4 p-4 overflow-y-auto space-y-3 shadow-inner">
              {messages.length === 0 && (
                <div className="text-center text-slate-400 mt-10">
                  <p>等待连接...</p>
                  <p className="text-xs mt-1">请在另一台设备输入房间号：<span className="font-mono font-bold text-slate-600">{roomId}</span></p>
                  <p className="text-xs mt-1">或点击上方二维码图标扫描加入</p>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.sender === 'me' ? 'justify-end' : msg.sender === 'system' ? 'justify-center' : 'justify-start'}`}>
                  {msg.sender === 'system' ? (
                    <span className="text-xs bg-slate-200 text-slate-600 px-2 py-1 rounded-full">{msg.text}</span>
                  ) : (
                    <div className={`max-w-[80%] p-3 rounded-lg text-sm ${msg.sender === 'me' ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white text-slate-800 rounded-bl-none shadow-sm'}`}>
                      {msg.text}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {transferProgress > 0 && (
               <div className="mb-4 bg-white p-3 rounded-lg shadow-sm border border-slate-200">
                 <div className="flex justify-between text-xs mb-1">
                   <span>传输中...</span>
                   <span>{transferProgress}%</span>
                 </div>
                 <div className="w-full bg-slate-100 rounded-full h-2">
                   <div 
                     className="bg-indigo-600 h-2 rounded-full transition-all duration-300" 
                     style={{ width: `${transferProgress}%` }}
                   ></div>
                 </div>
               </div>
            )}

            {files.length > 0 && (
              <div className="mb-4 space-y-2 max-h-32 overflow-y-auto">
                 {files.map((file, i) => (
                   <div key={i} className="flex items-center justify-between p-3 bg-white border border-slate-200 rounded-lg shadow-sm">
                     <div className="flex items-center gap-3 overflow-hidden">
                       <FileText className="text-indigo-500 flex-shrink-0" />
                       <div className="min-w-0">
                         <p className="text-sm font-medium truncate">{file.name}</p>
                         <p className="text-xs text-slate-400">{formatBytes(file.size)}</p>
                       </div>
                     </div>
                     {file.sender === 'peer' ? (
                       <a href={file.url} download={file.name} className="p-2 bg-emerald-100 text-emerald-700 rounded-full hover:bg-emerald-200">
                         <Download size={16} />
                       </a>
                     ) : (
                       <span className="text-xs text-slate-400 px-2">已发送</span>
                     )}
                   </div>
                 ))}
              </div>
            )}

            <div className="flex gap-2">
              <label className={`p-3 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${connectionStatus !== 'connected' || isSending ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-slate-800 text-white hover:bg-slate-700'}`}>
                <FileText size={20} />
                <input 
                  type="file" 
                  className="hidden" 
                  disabled={connectionStatus !== 'connected' || isSending}
                  onChange={(e) => {
                    if (e.target.files[0]) sendFile(e.target.files[0]);
                  }}
                />
              </label>
              
              <div className="flex-grow flex gap-2">
                <input 
                  type="text" 
                  value={inputMsg}
                  onChange={(e) => setInputMsg(e.target.value)}
                  placeholder={connectionStatus === 'connected' ? "输入消息..." : "等待连接..."}
                  disabled={connectionStatus !== 'connected'}
                  className="flex-grow p-3 rounded-lg border border-slate-300 focus:outline-none focus:border-indigo-500"
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                />
                <button 
                  onClick={sendMessage}
                  disabled={connectionStatus !== 'connected'}
                  className="p-3 bg-indigo-600 text-white rounded-lg disabled:opacity-50"
                >
                  <Send size={20} />
                </button>
              </div>
            </div>

            <button onClick={() => window.location.reload()} className="mt-4 text-xs text-slate-400 text-center hover:text-red-500">
              断开并重置
            </button>
          </div>
        )}
      </main>
    </div>
  );
}