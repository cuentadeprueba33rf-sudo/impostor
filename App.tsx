
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GameScreen, Player, Role, Difficulty, GameMode, ChatMessage } from './types';
import { generateWord } from './services/geminiService';
import { 
  supabase, 
  createRoom, 
  joinRoom, 
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
      case 'alert':
        osc.type = 'square';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.setValueAtTime(300, now + 0.1);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        osc.start(now); osc.stop(now + 0.4);
        break;
      case 'reveal':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.linearRampToValueAtTime(160, now + 0.5);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
        osc.start(now); osc.stop(now + 0.6);
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
  if (player.photo) return <img src={player.photo} alt={player.name} className={`${sizeClasses[size]} ${className} rounded-full object-cover ring-2 ring-red-500 shadow-[0_0_10px_rgba(255,0,0,0.5)]`} />;
  return (
    <div className={`${sizeClasses[size]} ${className} bg-gradient-to-br from-red-600 to-red-950 rounded-full flex items-center justify-center ring-2 ring-red-500 shadow-[0_0_15px_rgba(255,0,0,0.4)]`}>
      <span className="font-brand font-bold text-white text-xl">{player.name.charAt(0).toUpperCase()}</span>
    </div>
  );
};

export default function App() {
  const [screen, setScreen] = useState<GameScreen>(GameScreen.LOADING);
  const [mode, setMode] = useState<GameMode>('local');
  const [players, setPlayers] = useState<Player[]>([]);
  const [me, setMe] = useState<Player | null>(null);
  const [room, setRoom] = useState<any>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [photoInput, setPhotoInput] = useState<string | null>(null);
  const [secretWord, setSecretWord] = useState('');
  const [revealIndex, setRevealIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [numImpostors, setNumImpostors] = useState(1);
  const [difficulty, setDifficulty] = useState<Difficulty>('Fácil');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [onlineMessages, setOnlineMessages] = useState<any[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [showTurnAnnounce, setShowTurnAnnounce] = useState(false);
  
  // Loading screen states
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingText, setLoadingText] = useState("INICIALIZANDO PROTOCOLO...");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef(screen);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [onlineMessages]);

  const fetchPlayers = async (roomId: string) => {
    const { data } = await supabase
      .from('players')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });
    
    if (data) {
      setPlayers(data as any);
      if (me) {
        const updatedMe = data.find(p => p.id === me.id);
        if (updatedMe) setMe(updatedMe as any);
      }
    }
  };

  useEffect(() => {
    if (!room) return;
    fetchPlayers(room.id);
    const roomChannel = supabase
      .channel(`room:${room.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, payload => {
        const updatedRoom = payload.new;
        setRoom(updatedRoom);
        if (updatedRoom.status !== screenRef.current) {
          changeScreen(updatedRoom.status as any);
        }
        if (updatedRoom.secret_word) setSecretWord(updatedRoom.secret_word);
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
      const texts = [
        "ESTABLECIENDO ENLACE CIFRADO...",
        "SINCRONIZANDO NODOS DE RED...",
        "VERIFICANDO FIRMAS DIGITALES...",
        "CARGANDO BASE DE DATOS DE INTEL...",
        "DESPLEGANDO CONTRAMEDIDAS...",
        "AUTENTICANDO ACCESO NIVEL 5...",
        "SISTEMA LISTO PARA OPERACIÓN."
      ];
      
      let currentIdx = 0;
      const textInterval = setInterval(() => {
        currentIdx = (currentIdx + 1) % texts.length;
        setLoadingText(texts[currentIdx]);
      }, 600);

      const progressInterval = setInterval(() => {
        setLoadingProgress(prev => {
          if (prev >= 100) {
            clearInterval(progressInterval);
            clearInterval(textInterval);
            setTimeout(() => changeScreen(GameScreen.MODE_SELECTION), 500);
            return 100;
          }
          return prev + 1;
        });
      }, 40);

      return () => {
        clearInterval(textInterval);
        clearInterval(progressInterval);
      };
    }
  }, []);

  const changeScreen = (newScreen: GameScreen) => {
    soundService.init();
    soundService.play('swoosh');
    setIsTransitioning(true);
    setTimeout(() => {
      setScreen(newScreen);
      setIsTransitioning(false);
      if (newScreen === GameScreen.ONLINE_GAMEPLAY) {
        setShowTurnAnnounce(true);
        setTimeout(() => setShowTurnAnnounce(false), 3000);
      }
    }, 400);
  };

  const handleCreateOnline = async () => {
    if (!nameInput.trim()) return alert("Ingresa tu ALIAS");
    setIsLoading(true);
    try {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const newRoom = await createRoom(code);
      const player = await addPlayerToRoom(newRoom.id, nameInput, photoInput, true);
      setRoom(newRoom);
      setMe(player as any);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error al crear sala"); }
    finally { setIsLoading(false); }
  };

  const handleJoinOnline = async () => {
    if (!nameInput.trim()) return alert("Escribe tu ALIAS primero");
    if (!roomCodeInput.trim()) return alert("Ingresa el CÓDIGO");
    setIsLoading(true);
    try {
      const joinedRoom = await joinRoom(roomCodeInput);
      if (!joinedRoom) return alert("SALA NO ENCONTRADA");
      const player = await addPlayerToRoom(joinedRoom.id, nameInput, photoInput, false);
      setRoom(joinedRoom);
      setMe(player as any);
      changeScreen(GameScreen.ONLINE_LOBBY);
    } catch (e) { alert("Error al unirse"); }
    finally { setIsLoading(false); }
  };

  const handleStartGame = async () => {
    if (players.length < 3) return alert("Faltan agentes (Mínimo 3)");
    setIsLoading(true);
    try {
      const word = await generateWord('Random', difficulty);
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      const impIds = shuffled.slice(0, numImpostors).map(p => p.id);
      for (const p of players) {
        await supabase.from('players').update({ role: impIds.includes(p.id) ? 'Impostor' : 'Civil' }).eq('id', p.id);
      }
      await updateRoomStatus(room.id, 'ROLE_REVEAL_TRANSITION', { 
        secret_word: word, 
        current_turn_index: Math.floor(Math.random() * players.length) 
      });
    } catch (e) { alert("Error en el despliegue"); }
    finally { setIsLoading(false); }
  };

  const handleSendMessage = async () => {
    if (!currentInput.trim() || !room || !me) return;
    try {
      await sendMessage(room.id, me.id, me.name, currentInput);
      const nextIndex = (room.current_turn_index + 1) % players.length;
      await rotateTurn(room.id, nextIndex);
      setCurrentInput('');
    } catch (e) { console.error(e); }
  };

  const renderContent = () => {
    switch (screen) {
      case GameScreen.LOADING: 
        return (
          <div className="flex flex-col items-center justify-center h-full relative overflow-hidden px-8">
            {/* Background Decorative Element */}
            <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
              <div className="w-[150vw] h-[150vw] border-[1px] border-red-600 rounded-full animate-spin-slow"></div>
              <div className="absolute w-[120vw] h-[120vw] border-[1px] border-red-600 rounded-full animate-spin-slow" style={{animationDirection: 'reverse'}}></div>
            </div>

            {/* Main Terminal Header */}
            <div className="relative z-10 mb-12">
               <h1 className="text-7xl md:text-9xl font-brand font-black text-white animate-glitch tracking-widest text-center leading-none">
                 IMPOSTOR <br/> 
                 <span className="text-red-600 text-5xl md:text-7xl">PROTOCOLO</span>
               </h1>
               <div className="absolute -top-10 -right-10 px-4 py-1 border border-red-600 text-red-600 text-[10px] font-mono tracking-widest animate-pulse">
                 SECURE_UPLINK_ON
               </div>
            </div>

            {/* Central Radar / Progress */}
            <div className="relative w-48 h-48 mb-12 flex items-center justify-center">
               <svg className="w-full h-full transform -rotate-90">
                 <circle
                   cx="96" cy="96" r="80"
                   stroke="currentColor" strokeWidth="2" fill="transparent"
                   className="text-zinc-900"
                 />
                 <circle
                   cx="96" cy="96" r="80"
                   stroke="currentColor" strokeWidth="4" fill="transparent"
                   strokeDasharray={2 * Math.PI * 80}
                   strokeDashoffset={2 * Math.PI * 80 * (1 - loadingProgress / 100)}
                   className="text-red-600 drop-shadow-[0_0_10px_rgba(255,0,0,0.8)]"
                 />
               </svg>
               <div className="absolute flex flex-col items-center">
                 <span className="text-4xl font-brand text-white">{loadingProgress}%</span>
                 <span className="text-[8px] font-mono text-zinc-500 uppercase tracking-widest">Sincronizando</span>
               </div>
               <div className="absolute inset-0 border-2 border-red-600/20 rounded-full animate-pulse-soft"></div>
            </div>

            {/* Tactical Logs */}
            <div className="w-full max-w-md h-24 flex flex-col items-center justify-start text-center">
              <p className="font-mono text-red-600 text-xs tracking-widest mb-2 opacity-80 uppercase italic">
                {loadingText}
              </p>
              <div className="w-full bg-zinc-900/50 h-[2px] rounded-full overflow-hidden">
                <div className="h-full bg-red-600 transition-all duration-300" style={{ width: `${loadingProgress}%` }}></div>
              </div>
              <div className="mt-4 flex gap-4 text-[8px] font-mono text-zinc-600 uppercase tracking-widest">
                <span>UID: {Math.random().toString(16).substring(2, 10)}</span>
                <span>ENC: AES-256</span>
                <span>STATUS: OPS_READY</span>
              </div>
            </div>
          </div>
        );
      case GameScreen.MODE_SELECTION: 
        return (
          <div className="flex flex-col h-full p-8 justify-center items-center gap-10 animate-fadeInUp">
            <h2 className="text-6xl font-brand text-white text-center tracking-widest text-glow-red italic">SISTEMA</h2>
            <button onClick={() => { setMode('local'); changeScreen(GameScreen.SETUP); }} className="glass-card w-full max-w-sm p-8 flex flex-col items-center gap-2 border-l-8 border-l-red-600 active:scale-95">
              <h3 className="text-3xl font-brand text-white">MISIÓN LOCAL</h3>
              <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest italic">Presencial • Un dispositivo</p>
            </button>
            <button onClick={() => { setMode('online'); changeScreen(GameScreen.ONLINE_SETUP); }} className="glass-card w-full max-w-sm p-8 flex flex-col items-center gap-2 border-l-8 border-l-white active:scale-95">
              <h3 className="text-3xl font-brand text-white">RED REMOTA</h3>
              <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest italic">Multi-dispositivo • Realtime</p>
            </button>
          </div>
        );
      case GameScreen.ONLINE_SETUP:
        return (
          <div className="flex flex-col h-full p-6 animate-fadeInUp">
            <button onClick={() => changeScreen(GameScreen.MODE_SELECTION)} className="self-start text-red-600 font-black mb-8 uppercase tracking-widest text-sm italic">← Atrás</button>
            <div className="flex-1 flex flex-col justify-center gap-6 max-w-sm mx-auto w-full">
              <div className="glass-panel p-6 rounded-[35px] border-2 border-zinc-800 shadow-2xl">
                 <p className="text-[10px] text-zinc-500 font-black uppercase mb-3 tracking-widest text-center italic">Identificación</p>
                 <input type="text" placeholder="TU ALIAS" value={nameInput} onChange={e => setNameInput(e.target.value)} className="w-full bg-black border-2 border-zinc-800 rounded-2xl px-4 py-4 text-white font-brand text-2xl outline-none focus:border-red-600 uppercase tracking-widest text-center" />
              </div>
              <div className="glass-panel p-6 rounded-[40px] border-2 border-red-600/30">
                <h2 className="text-2xl font-brand text-white mb-4 tracking-widest text-center uppercase">Código de Sala</h2>
                <input type="text" maxLength={6} placeholder="XXXXXX" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value)} className="w-full bg-black border-2 border-zinc-800 rounded-2xl px-4 py-4 text-4xl font-brand tracking-[0.5em] text-center text-red-600 outline-none focus:border-red-600 mb-6 uppercase" />
                <button onClick={handleJoinOnline} disabled={isLoading} className="w-full btn-primary py-4 rounded-2xl text-xl uppercase tracking-widest">Sincronizar</button>
              </div>
              <div className="h-px bg-zinc-800 relative"><span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-black px-4 text-xs font-bold text-zinc-600">O</span></div>
              <button onClick={handleCreateOnline} disabled={isLoading} className="btn-danger w-full py-5 rounded-2xl font-brand text-2xl tracking-widest uppercase italic">Crear Nueva Red</button>
            </div>
          </div>
        );
      case GameScreen.ONLINE_LOBBY:
        return (
          <div className="flex flex-col h-full bg-black">
             <div className="p-6 border-b border-red-600/20 flex items-center justify-between glass-panel">
                <button onClick={() => setRoom(null)} className="text-zinc-400 font-black text-xs uppercase tracking-widest italic">Salir</button>
                <div className="text-center">
                  <p className="text-[10px] font-black text-red-600 uppercase tracking-widest">CANAL ACTIVO</p>
                  <h2 className="text-4xl font-brand text-white text-glow-red tracking-widest">{room?.code}</h2>
                </div>
                <div className="w-12 h-12 rounded-xl bg-red-600/10 border border-red-600/50 flex items-center justify-center font-brand text-2xl text-red-600">{players.length}</div>
             </div>
             <div className="flex-1 p-8 overflow-y-auto scrollbar-hide">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest italic">Agentes en frecuencia</h3>
                  {players.length === 0 && <div className="w-4 h-4 border-2 border-red-600 border-t-transparent rounded-full animate-spin"></div>}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {players.map(p => (
                    <div key={p.id} className="glass-card p-4 rounded-3xl flex flex-col items-center gap-3 border-b-4 border-b-red-600 animate-fadeInUp">
                      <PlayerAvatar player={p} size="md" />
                      <span className="text-sm font-black text-white uppercase tracking-wider">{p.name} {p.is_host && "👑"}</span>
                    </div>
                  ))}
                </div>
             </div>
             <div className="p-8">
               {me?.is_host ? (
                 <button onClick={handleStartGame} disabled={isLoading || players.length < 3} className="w-full btn-primary py-5 rounded-3xl font-brand text-2xl shadow-[0_10px_30px_rgba(255,0,0,0.4)] disabled:opacity-30">INICIAR OPERACIÓN</button>
               ) : (
                 <div className="text-center py-6 bg-zinc-900/30 rounded-3xl border border-zinc-800">
                    <p className="text-sm font-bold text-red-600 animate-pulse tracking-widest uppercase italic">Esperando señal del Líder...</p>
                 </div>
               )}
             </div>
          </div>
        );
      default: return null;
    }
  };

  return (
    <main className={`h-full w-full transition-all duration-500 ${isTransitioning ? 'opacity-0 scale-90 blur-xl' : 'opacity-100 scale-100 blur-0'}`}>
      <style>{`
        @keyframes glowBorder {
          0% { border-color: #ff0000; box-shadow: 0 0 5px rgba(255,0,0,0.1); }
          50% { border-color: #8b0000; box-shadow: 0 0 15px rgba(255,0,0,0.3); }
          100% { border-color: #ff0000; box-shadow: 0 0 5px rgba(255,0,0,0.1); }
        }
      `}</style>
      {renderContent()}
    </main>
  );
}
