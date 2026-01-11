
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameScreen, Player, Role, Difficulty, GameMode, ChatMessage } from './types';
import { generateWord } from './services/geminiService';
import { 
  supabase, 
  createRoom, 
  joinRoom, 
  getPublicRooms,
  addPlayerToRoom, 
  updateRoomStatus, 
  sendMessage,
  rotateTurn 
} from './services/supabaseService';

// --- Tactical Sound Service ---
const soundService = {
  ctx: null as AudioContext | null,
  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  },
  play(type: 'click' | 'swoosh') {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    if (type === 'click') {
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'swoosh') {
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.2);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    }
  }
};

const PlayerAvatar: React.FC<{ player: Player; size?: 'sm' | 'md' | 'lg' }> = ({ player, size = 'md' }) => {
  const sizeClasses = { sm: 'w-10 h-10 text-xs', md: 'w-16 h-16 text-xl', lg: 'w-24 h-24 text-3xl' };
  return (
    <div className={`${sizeClasses[size]} bg-zinc-900 rounded-2xl flex items-center justify-center border border-white/10 shadow-xl overflow-hidden relative group`}>
      <div className="absolute inset-0 bg-gradient-to-br from-red-600/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      <span className="font-brand font-bold text-white z-10">{player.name?.charAt(0).toUpperCase() || '?'}</span>
    </div>
  );
};

export default function App() {
  const [screen, setScreen] = useState<GameScreen>(GameScreen.LOADING);
  const [players, setPlayers] = useState<Player[]>([]);
  const [me, setMe] = useState<Player | null>(null);
  const [room, setRoom] = useState<any>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [nameInput, setNameInput] = useState(localStorage.getItem('agent_alias') || '');
  const [publicRooms, setPublicRooms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Estados temporales para la reconexión
  const [pendingSession, setPendingSession] = useState<{ room: any, me: Player } | null>(null);

  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  useEffect(() => {
    if (nameInput) localStorage.setItem('agent_alias', nameInput);
  }, [nameInput]);

  const addLog = (msg: string) => {
    setTerminalLogs(prev => [...prev.slice(-2), msg]);
  };

  const fetchPlayers = async (roomId: string) => {
    console.log("Fetching players for room:", roomId);
    const { data } = await supabase
      .from('players')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });
    
    if (data) {
      setPlayers(data as any);
      if (me) {
        const currentMe = data.find(p => p.id === me.id);
        if (currentMe) setMe(currentMe as any);
      }
    }
  };

  const tryReconnect = async () => {
    const savedRoomId = localStorage.getItem('last_room_id');
    const savedPlayerId = localStorage.getItem('last_player_id');
    if (savedRoomId && savedPlayerId) {
      addLog("DETECTANDO SEÑAL PREVIA...");
      const { data: roomData } = await supabase.from('rooms').select('*').eq('id', savedRoomId).single();
      const { data: playerData } = await supabase.from('players').select('*').eq('id', savedPlayerId).single();
      
      if (roomData && playerData) {
        // En lugar de entrar directo, guardamos y preguntamos
        setPendingSession({ room: roomData, me: playerData as any });
        return true;
      }
    }
    return false;
  };

  const confirmReconnect = async () => {
    if (!pendingSession) return;
    setRoom(pendingSession.room);
    setMe(pendingSession.me);
    await fetchPlayers(pendingSession.room.id);
    changeScreen(pendingSession.room.status as any);
    setPendingSession(null);
  };

  const discardReconnect = () => {
    localStorage.removeItem('last_room_id');
    localStorage.removeItem('last_player_id');
    setPendingSession(null);
    changeScreen(GameScreen.MODE_SELECTION);
  };

  const refreshPublicRooms = async () => {
    setIsLoading(true);
    const rooms = await getPublicRooms();
    setPublicRooms(rooms);
    setIsLoading(false);
  };

  useEffect(() => {
    if (!room?.id) return;
    fetchPlayers(room.id);
    const channelId = `room_${room.id}_${Date.now()}`;
    const channel = supabase
      .channel(channelId)
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'players', 
        filter: `room_id=eq.${room.id}` 
      }, () => fetchPlayers(room.id))
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: 'rooms', 
        filter: `id=eq.${room.id}` 
      }, (payload) => {
        setRoom(payload.new);
        if (payload.new.status !== screenRef.current) {
          changeScreen(payload.new.status as any);
        }
      })
      .subscribe();

    const backupInterval = setInterval(() => fetchPlayers(room.id), 5000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(backupInterval);
    };
  }, [room?.id]);

  useEffect(() => {
    if (screen === GameScreen.LOADING) {
      const boot = async () => {
        const hasPending = await tryReconnect();
        let p = 0;
        const inv = setInterval(() => {
          p += 2;
          setLoadingProgress(p);
          if (p === 20) addLog("SCANNING PROTOCOLS...");
          if (p === 60) addLog("ESTABLISHING UPLINK...");
          if (p >= 100) {
            clearInterval(inv);
            if (hasPending) {
              setScreen(GameScreen.RECONNECT_PROMPT);
            } else {
              changeScreen(GameScreen.MODE_SELECTION);
            }
          }
        }, 20);
      };
      boot();
    }
  }, []);

  const changeScreen = (newScreen: GameScreen) => {
    soundService.play('swoosh');
    setIsTransitioning(true);
    setTimeout(() => {
      setScreen(newScreen);
      setIsTransitioning(false);
    }, 400);
  };

  const handleCreateOnline = async () => {
    if (!nameInput.trim()) return alert("Ingresa un Alias");
    setIsLoading(true);
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const newRoom = await createRoom(code);
      const player = await addPlayerToRoom(newRoom.id, nameInput, null, true);
      setRoom(newRoom);
      setMe(player as any);
      localStorage.setItem('last_room_id', newRoom.id);
      localStorage.setItem('last_player_id', player.id);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error al crear sala"); }
    finally { setIsLoading(false); }
  };

  const handleJoinOnline = async (code: string) => {
    if (!nameInput.trim()) return alert("Alias requerido");
    setIsLoading(true);
    try {
      const targetRoom = await joinRoom(code);
      if (!targetRoom) return alert("Código no válido");
      const player = await addPlayerToRoom(targetRoom.id, nameInput, null, false);
      setRoom(targetRoom);
      setMe(player as any);
      localStorage.setItem('last_room_id', targetRoom.id);
      localStorage.setItem('last_player_id', player.id);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error al unirse"); }
    finally { setIsLoading(false); }
  };

  const handleLeave = () => {
    localStorage.removeItem('last_room_id');
    localStorage.removeItem('last_player_id');
    setRoom(null);
    setMe(null);
    changeScreen(GameScreen.MODE_SELECTION);
  };

  const renderContent = () => {
    switch (screen) {
      case GameScreen.LOADING:
        return (
          <div className="flex flex-col items-center justify-center h-full px-12">
            <div className="w-20 h-20 mb-12 relative animate-float">
               <div className="absolute inset-0 border border-red-600/30 rounded-full animate-ping"></div>
               <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-3 h-3 bg-red-600 rounded-full shadow-[0_0_15px_#ff0000]"></div>
               </div>
            </div>
            <h1 className="text-4xl font-brand text-white tracking-[0.3em] mb-10 text-glow">MODERN OPS</h1>
            <div className="w-full max-w-xs space-y-4">
              <div className="loading-bar-container">
                <div className="loading-bar-fill" style={{ width: `${loadingProgress}%` }}></div>
              </div>
              <div className="flex flex-col items-center gap-1">
                {terminalLogs.map((log, i) => (
                  <span key={i} className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">{log}</span>
                ))}
              </div>
            </div>
          </div>
        );
      case GameScreen.RECONNECT_PROMPT:
        return (
          <div className="flex flex-col h-full p-10 items-center justify-center text-center">
            <div className="mb-12 relative">
               <div className="w-24 h-24 rounded-full border-4 border-red-600/20 flex items-center justify-center">
                  <div className="w-3 h-3 bg-red-600 rounded-full animate-pulse shadow-[0_0_20px_#ff0000]"></div>
               </div>
               <div className="absolute -top-2 -right-2 bg-red-600 text-[8px] font-black px-2 py-1 rounded-md text-white tracking-widest">SIGNAL DETECTED</div>
            </div>
            <h2 className="text-5xl font-brand text-white mb-4 tracking-widest">¿RETOMAR MISIÓN?</h2>
            <p className="text-zinc-500 text-xs font-mono uppercase tracking-widest mb-12 max-w-[250px]">
               Se ha detectado una sesión activa en el nodo <span className="text-white font-bold">[{pendingSession?.room?.code}]</span>. ¿Deseas volver a la frecuencia?
            </p>
            <div className="w-full max-w-xs space-y-4">
               <button onClick={confirmReconnect} className="btn-modern w-full py-6 rounded-3xl text-2xl shadow-red-600/30">RETOMAR CONEXIÓN</button>
               <button onClick={discardReconnect} className="w-full py-5 rounded-3xl text-[10px] font-black text-zinc-600 hover:text-white transition-colors tracking-[0.3em] border border-white/5 uppercase">Nueva Operación</button>
            </div>
          </div>
        );
      case GameScreen.MODE_SELECTION:
        return (
          <div className="flex flex-col h-full p-8 items-center justify-center">
            <div className="mb-20 text-center">
              <span className="text-red-600 font-bold text-[10px] tracking-[0.5em] uppercase mb-3 block">Global Command</span>
              <h2 className="text-8xl font-brand text-white italic text-glow">CENTRAL</h2>
            </div>
            <div className="w-full max-w-sm">
              <button onClick={() => { refreshPublicRooms(); changeScreen(GameScreen.ONLINE_SETUP); }} className="glass-card w-full p-10 group active:scale-[0.98] transition-all border-none">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-4xl font-brand text-white group-hover:text-red-500 transition-colors">OPERACIÓN ONLINE</h3>
                  <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></div>
                </div>
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest text-left">Conexión con agentes remotos</p>
              </button>
            </div>
          </div>
        );
      case GameScreen.ONLINE_SETUP:
        return (
          <div className="flex flex-col h-full p-8 overflow-y-auto scrollbar-hide">
            <button onClick={() => changeScreen(GameScreen.MODE_SELECTION)} className="self-start text-[10px] font-black text-zinc-600 hover:text-white transition-colors mb-16 tracking-widest">← MENU</button>
            <div className="max-w-sm mx-auto w-full space-y-12">
              <div className="space-y-4">
                <p className="text-[10px] text-red-600 font-bold uppercase tracking-[0.4em]">Codename de Agente</p>
                <input type="text" placeholder="TU ALIAS" value={nameInput} onChange={e => setNameInput(e.target.value)} className="w-full bg-transparent border-b border-white/10 py-5 text-5xl font-brand text-white outline-none focus:border-red-600 transition-colors uppercase" />
              </div>

              <div className="grid gap-4">
                <button onClick={handleCreateOnline} className="btn-modern w-full py-6 rounded-3xl text-2xl">CREAR NUEVO NODO</button>
                <div className="flex gap-3">
                  <input type="text" placeholder="CÓDIGO" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-white/5 rounded-3xl px-8 font-brand text-2xl text-white outline-none border border-white/5 focus:border-white/20" />
                  <button onClick={() => handleJoinOnline(roomCodeInput)} className="bg-white text-black font-bold px-10 py-5 rounded-3xl text-[10px] tracking-widest hover:bg-zinc-200 transition-colors">ENTRAR</button>
                </div>
              </div>

              <div className="pt-12 border-t border-white/5">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Nodos Disponibles</h3>
                  <button onClick={refreshPublicRooms} className="text-[10px] text-red-600 font-bold hover:underline">REFRESCAR</button>
                </div>
                <div className="space-y-5">
                  {isLoading && <p className="text-center text-zinc-600 text-[10px] font-mono animate-pulse">SINCRONIZANDO RED...</p>}
                  {!isLoading && publicRooms.length === 0 && <p className="text-center text-zinc-800 text-xs font-mono py-10 italic">No hay señales activas...</p>}
                  {publicRooms.map(r => (
                    <div key={r.id} onClick={() => handleJoinOnline(r.code)} className="glass-card p-8 flex justify-between items-center border border-white/5 hover:border-red-600/30 cursor-pointer transition-all">
                      <div>
                        <p className="font-brand text-white text-3xl tracking-widest">{r.code}</p>
                        <p className="text-[8px] text-zinc-600 font-bold uppercase mt-1">Status: Online</p>
                      </div>
                      <div className="text-right">
                        <p className="text-red-600 font-brand text-4xl leading-none">{r.players?.[0]?.count || 0}<span className="text-sm text-zinc-800">/8</span></p>
                        <p className="text-[8px] text-zinc-600 font-bold uppercase mt-1">Agents</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      case GameScreen.ONLINE_LOBBY:
        return (
          <div className="flex flex-col h-full">
            <header className="p-10 flex justify-between items-center border-b border-white/5">
              <button onClick={handleLeave} className="text-zinc-600 text-[10px] font-black hover:text-red-500 transition-colors tracking-widest uppercase">Abortar</button>
              <div className="text-center">
                <p className="text-[8px] text-red-600 font-bold tracking-[0.6em] mb-2 uppercase">Canal Operativo</p>
                <h2 className="text-5xl font-brand text-white tracking-[0.2em]">{room?.code}</h2>
              </div>
              <div className="w-12 h-12 rounded-2xl border border-white/10 flex items-center justify-center font-brand text-2xl text-white">{players.length}</div>
            </header>

            <div className="flex-1 p-10 overflow-y-auto scrollbar-hide">
              <div className="flex justify-between items-center mb-10">
                <p className="text-[10px] text-zinc-600 font-bold uppercase tracking-widest italic">Agentes en Frecuencia</p>
                <div className="flex gap-2">
                  <div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-ping"></div>
                  <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-8">
                {players.map(p => (
                  <div key={p.id} className="glass-card p-8 flex flex-col items-center gap-5 border-none hover:bg-white/5 transition-all">
                    <PlayerAvatar player={p} size="md" />
                    <div className="text-center">
                      <p className="text-sm font-bold text-white uppercase tracking-wider truncate w-28">{p.name}</p>
                      {p.is_host && <p className="text-[7px] text-red-500 font-black uppercase mt-2 tracking-widest bg-red-500/10 px-2 py-0.5 rounded">Host</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <footer className="p-10">
              {me?.is_host ? (
                <div className="space-y-4">
                  <button 
                    onClick={() => updateRoomStatus(room.id, 'ONLINE_GAMEPLAY')} 
                    disabled={players.length < 2} 
                    className="btn-modern w-full py-7 rounded-3xl text-3xl shadow-red-600/20 disabled:opacity-30 active:scale-95 transition-all"
                  >
                    INICIAR MISIÓN
                  </button>
                  {players.length < 2 && (
                    <p className="text-center text-[9px] text-zinc-600 font-bold uppercase tracking-widest">Esperando agentes (Mín: 2)</p>
                  )}
                </div>
              ) : (
                <div className="py-8 rounded-3xl bg-white/5 text-center border border-white/5">
                   <p className="text-xs font-bold text-red-600 animate-pulse tracking-[0.3em] uppercase italic">Esperando órdenes del líder...</p>
                </div>
              )}
            </footer>
          </div>
        );
      default: return null;
    }
  };

  return (
    <main className={`h-full w-full transition-all duration-700 ${isTransitioning ? 'opacity-0 scale-98 blur-xl' : 'opacity-100 scale-100 blur-0'}`}>
      {renderContent()}
    </main>
  );
}
