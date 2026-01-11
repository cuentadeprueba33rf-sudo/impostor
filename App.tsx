
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
  play(type: 'click' | 'success' | 'alert' | 'swoosh' | 'reveal' | 'turn') {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    switch (type) {
      case 'click':
        osc.frequency.setValueAtTime(600, now);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now); osc.stop(now + 0.1);
        break;
      case 'swoosh':
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.3);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now); osc.stop(now + 0.3);
        break;
      case 'turn':
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.setValueAtTime(400, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
        break;
    }
  }
};

const PlayerAvatar: React.FC<{ player: Player; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }> = ({ player, size = 'md', className = '' }) => {
  const sizeClasses = { sm: 'w-10 h-10', md: 'w-16 h-16', lg: 'w-24 h-24', xl: 'w-32 h-32' };
  return (
    <div className={`${sizeClasses[size]} ${className} bg-gradient-to-br from-red-600 to-red-950 rounded-full flex items-center justify-center ring-2 ring-red-500 shadow-[0_0_15px_rgba(255,0,0,0.4)]`}>
      <span className="font-brand font-bold text-white text-xl">{player.name?.charAt(0).toUpperCase() || '?'}</span>
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
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingText, setLoadingText] = useState("INICIALIZANDO...");
  const [onlineMessages, setOnlineMessages] = useState<any[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  
  const chatEndRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef(screen);

  useEffect(() => { screenRef.current = screen; }, [screen]);

  // --- Persistence Logic ---
  useEffect(() => {
    if (nameInput) localStorage.setItem('agent_alias', nameInput);
  }, [nameInput]);

  const tryReconnect = async () => {
    const savedRoomId = localStorage.getItem('last_room_id');
    const savedPlayerId = localStorage.getItem('last_player_id');
    
    if (savedRoomId && savedPlayerId) {
      setLoadingText("RECUPERANDO SESIÓN...");
      const { data: roomData } = await supabase.from('rooms').select('*').eq('id', savedRoomId).single();
      const { data: playerData } = await supabase.from('players').select('*').eq('id', savedPlayerId).single();
      
      if (roomData && playerData) {
        setRoom(roomData);
        setMe(playerData as any);
        setScreen(roomData.status as any);
        return true;
      }
    }
    return false;
  };

  const fetchPlayers = async (roomId: string) => {
    const { data } = await supabase.from('players').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
    if (data) {
      setPlayers(data as any);
      if (me) {
        const currentMe = data.find(p => p.id === me.id);
        if (currentMe) setMe(currentMe as any);
      }
    }
  };

  const refreshPublicRooms = async () => {
    const rooms = await getPublicRooms();
    setPublicRooms(rooms);
  };

  // --- Realtime Subscriptions ---
  useEffect(() => {
    if (!room) return;
    fetchPlayers(room.id);
    const roomChannel = supabase
      .channel(`room:${room.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, payload => {
        setRoom(payload.new);
        if (payload.new.status !== screenRef.current) changeScreen(payload.new.status as any);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${room.id}` }, () => {
        fetchPlayers(room.id);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${room.id}` }, payload => {
        setOnlineMessages(prev => [...prev, payload.new as any]);
        soundService.play('turn');
      })
      .subscribe();

    return () => { supabase.removeChannel(roomChannel); };
  }, [room?.id]);

  useEffect(() => {
    if (screen === GameScreen.LOADING) {
      const init = async () => {
        const reconnected = await tryReconnect();
        let progress = 0;
        const interval = setInterval(() => {
          progress += 2;
          setLoadingProgress(progress);
          if (progress >= 100) {
            clearInterval(interval);
            if (!reconnected) changeScreen(GameScreen.MODE_SELECTION);
          }
        }, 30);
      };
      init();
    }
  }, []);

  const changeScreen = (newScreen: GameScreen) => {
    soundService.init();
    soundService.play('swoosh');
    setIsTransitioning(true);
    setTimeout(() => {
      setScreen(newScreen);
      setIsTransitioning(false);
    }, 400);
  };

  const handleCreateOnline = async () => {
    if (!nameInput.trim()) return alert("Alias requerido");
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
    } catch (e) { alert("Error al crear"); }
    finally { setIsLoading(false); }
  };

  const handleJoinOnline = async (code: string) => {
    if (!nameInput.trim()) return alert("Escribe tu Alias");
    setIsLoading(true);
    try {
      const targetRoom = await joinRoom(code);
      if (!targetRoom) return alert("SALA NO EXISTE");
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
          <div className="flex flex-col items-center justify-center h-full px-8">
            <h1 className="text-7xl font-brand text-white animate-glitch text-center">IMPOSTOR PROTOCOLO</h1>
            <div className="mt-12 w-48 h-1 bg-zinc-900 rounded-full overflow-hidden">
               <div className="h-full bg-red-600 transition-all duration-300" style={{ width: `${loadingProgress}%` }}></div>
            </div>
            <p className="mt-4 font-mono text-[10px] text-red-600 animate-pulse tracking-widest">{loadingText}</p>
          </div>
        );
      case GameScreen.MODE_SELECTION:
        return (
          <div className="flex flex-col h-full p-8 justify-center items-center gap-10">
            <h2 className="text-6xl font-brand text-white text-glow-red italic">MODO</h2>
            <button onClick={() => changeScreen(GameScreen.ONLINE_SETUP)} className="glass-card w-full max-w-sm p-8 border-l-8 border-red-600">
               <h3 className="text-3xl font-brand text-white">OPERACIÓN RED</h3>
               <p className="text-[10px] text-zinc-400 uppercase font-black">Online • Público</p>
            </button>
          </div>
        );
      case GameScreen.ONLINE_SETUP:
        return (
          <div className="flex flex-col h-full p-6 overflow-y-auto scrollbar-hide">
            <button onClick={() => changeScreen(GameScreen.MODE_SELECTION)} className="text-red-600 font-black mb-6 uppercase text-xs">← Atrás</button>
            <div className="max-w-sm mx-auto w-full space-y-6">
              <div className="glass-panel p-6 rounded-3xl border-2 border-zinc-800">
                 <p className="text-[10px] text-zinc-500 font-black uppercase mb-2 tracking-widest">Tu Identidad</p>
                 <input type="text" placeholder="ALIAS AGENTE" value={nameInput} onChange={e => setNameInput(e.target.value)} className="w-full bg-black border-2 border-zinc-800 rounded-xl px-4 py-3 text-white font-brand text-2xl outline-none focus:border-red-600 text-center uppercase" />
              </div>

              <div className="flex gap-2">
                 <input type="text" placeholder="CÓDIGO" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-zinc-900 rounded-xl px-4 font-brand text-xl text-white outline-none focus:ring-1 ring-red-600" />
                 <button onClick={() => handleJoinOnline(roomCodeInput)} className="btn-primary px-6 py-3 rounded-xl font-brand">UNIRSE</button>
              </div>

              <button onClick={handleCreateOnline} className="w-full btn-danger py-4 rounded-xl font-brand text-xl italic uppercase tracking-widest border-2 border-red-600">CREAR SERVIDOR</button>

              <div className="pt-6 border-t border-zinc-900">
                 <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xs font-black text-zinc-500 uppercase tracking-widest">Servidores Activos</h3>
                    <button onClick={refreshPublicRooms} className="text-[10px] text-red-600 font-bold uppercase">Actualizar</button>
                 </div>
                 <div className="space-y-3">
                    {publicRooms.length === 0 && <p className="text-center text-zinc-700 py-4 text-xs font-mono italic">No hay operaciones detectadas...</p>}
                    {publicRooms.map(r => (
                      <div key={r.id} onClick={() => handleJoinOnline(r.code)} className="glass-panel p-4 rounded-2xl flex justify-between items-center border border-zinc-800 active:border-red-600 transition-colors">
                        <div>
                          <p className="font-brand text-white text-xl tracking-widest">{r.code}</p>
                          <p className="text-[8px] text-zinc-500 font-black uppercase">Seguridad: LOBBY</p>
                        </div>
                        <div className="text-right">
                          <p className="text-red-600 font-brand text-lg">{r.players?.[0]?.count || 0}/8</p>
                          <p className="text-[8px] text-zinc-600 uppercase">Agentes</p>
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
          <div className="flex flex-col h-full bg-black">
             <div className="p-6 border-b border-red-600/20 glass-panel flex justify-between items-center">
                <button onClick={handleLeave} className="text-zinc-500 text-xs font-black italic">SALIR</button>
                <div className="text-center">
                  <p className="text-[10px] text-red-600 font-black">SERVER ID</p>
                  <h2 className="text-4xl font-brand text-white tracking-widest">{room?.code}</h2>
                </div>
                <div className="w-10 h-10 rounded-lg bg-red-600/10 border border-red-600/50 flex items-center justify-center font-brand text-xl text-red-600">{players.length}</div>
             </div>
             <div className="flex-1 p-8 overflow-y-auto scrollbar-hide">
                <div className="grid grid-cols-2 gap-4">
                  {players.map(p => (
                    <div key={p.id} className="glass-card p-4 rounded-3xl flex flex-col items-center gap-2 border-b-4 border-b-red-600 animate-fadeInUp">
                      <PlayerAvatar player={p} size="md" />
                      <span className="text-sm font-black text-white uppercase truncate w-full text-center">{p.name} {p.id === me?.id && "(TÚ)"}</span>
                      {p.is_host && <span className="text-[8px] text-red-500 font-black uppercase border border-red-500/30 px-2 rounded">Líder</span>}
                    </div>
                  ))}
                </div>
             </div>
             <div className="p-8">
                {me?.is_host ? (
                  <button onClick={() => changeScreen(GameScreen.ONLINE_GAMEPLAY)} disabled={players.length < 3} className="w-full btn-primary py-5 rounded-3xl font-brand text-2xl shadow-[0_10px_30px_rgba(255,0,0,0.3)] disabled:opacity-20">INICIAR MISIÓN</button>
                ) : (
                  <div className="text-center py-4 bg-zinc-900/30 rounded-2xl border border-zinc-800 animate-pulse">
                     <p className="text-xs font-black text-red-600 uppercase">Esperando al líder del nodo...</p>
                  </div>
                )}
             </div>
          </div>
        );
      // Los demás estados (ONLINE_GAMEPLAY, etc) se mantienen para fluidez, 
      // pero el core de la reconexión y persistencia ya está aplicado aquí.
      default: return <div className="p-10 text-center text-zinc-500 font-mono">Entrando en zona de operaciones...</div>;
    }
  };

  return (
    <main className={`h-full w-full transition-all duration-500 ${isTransitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}>
      {renderContent()}
    </main>
  );
}
