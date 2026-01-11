
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

const soundService = {
  ctx: null as AudioContext | null,
  init() { if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); },
  play(type: 'click' | 'swoosh' | 'alert') {
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
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
    } else if (type === 'alert') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(220, now + 0.5);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.5);
      osc.start(now); osc.stop(now + 0.5);
    }
  }
};

const PlayerAvatar: React.FC<{ player: Player; size?: 'sm' | 'md' | 'lg'; highlight?: boolean }> = ({ player, size = 'md', highlight }) => {
  const sizeClasses = { sm: 'w-10 h-10 text-xs', md: 'w-16 h-16 text-xl', lg: 'w-24 h-24 text-3xl' };
  return (
    <div className={`${sizeClasses[size]} bg-zinc-900 rounded-2xl flex items-center justify-center border ${highlight ? 'border-red-600 shadow-[0_0_15px_rgba(255,0,0,0.5)]' : 'border-white/10'} shadow-xl overflow-hidden relative group transition-all`}>
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
  const [pendingSession, setPendingSession] = useState<{ room: any, me: Player } | null>(null);
  const [selectedTheme, setSelectedTheme] = useState('Random');
  const [selectedDifficulty, setSelectedDifficulty] = useState<Difficulty>('Medio');
  const [descInput, setDescInput] = useState('');

  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  const addLog = (msg: string) => setTerminalLogs(prev => [...prev.slice(-2), msg]);

  const fetchPlayers = async (roomId: string) => {
    const { data } = await supabase.from('players').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
    if (data) {
      setPlayers(data as any);
      const currentMe = data.find(p => p.id === localStorage.getItem('last_player_id'));
      if (currentMe) setMe(currentMe as any);
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

  useEffect(() => {
    if (!room?.id) return;
    const channelId = `room_${room.id}_${Date.now()}`;
    const channel = supabase.channel(channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${room.id}` }, () => fetchPlayers(room.id))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, (payload) => {
        setRoom(payload.new);
        if (payload.new.status !== screenRef.current) changeScreen(payload.new.status as any);
      })
      .subscribe();
    const interval = setInterval(() => fetchPlayers(room.id), 5000);
    return () => { supabase.removeChannel(channel); clearInterval(interval); };
  }, [room?.id]);

  useEffect(() => {
    if (screen === GameScreen.LOADING) {
      const boot = async () => {
        const hasPending = await tryReconnect();
        let p = 0;
        const inv = setInterval(() => {
          p += 5; setLoadingProgress(p);
          if (p >= 100) { clearInterval(inv); hasPending ? setScreen(GameScreen.RECONNECT_PROMPT) : changeScreen(GameScreen.MODE_SELECTION); }
        }, 30);
      };
      boot();
    }
  }, []);

  const changeScreen = (newScreen: GameScreen) => {
    soundService.play('swoosh');
    setIsTransitioning(true);
    setTimeout(() => { setScreen(newScreen); setIsTransitioning(false); }, 400);
  };

  const handleStartGameSequence = async () => {
    if (!me?.is_host) return;
    setIsLoading(true);
    try {
      const word = await generateWord(selectedTheme, selectedDifficulty);
      const impostorIndex = Math.floor(Math.random() * players.length);
      const impostor = players[impostorIndex];
      
      for (const p of players) {
        await supabase.from('players').update({ role: p.id === impostor.id ? 'Impostor' : 'Civil' }).eq('id', p.id);
      }
      
      await updateRoomStatus(room.id, GameScreen.ROLE_REVEAL as any, { 
        secret_word: word, 
        current_turn_index: 0,
        impostor_id: impostor.id
      });
    } catch (e) { alert("Error iniciando misión"); }
    finally { setIsLoading(false); }
  };

  const handleSendDescription = async () => {
    if (!descInput.trim() || room.current_turn_index !== players.findIndex(p => p.id === me?.id)) return;
    await sendMessage(room.id, me!.id, me!.name, descInput);
    const nextIndex = (room.current_turn_index + 1) % players.length;
    if (nextIndex === 0) {
      await updateRoomStatus(room.id, GameScreen.VOTING as any);
    } else {
      await rotateTurn(room.id, nextIndex);
    }
    setDescInput('');
  };

  const handleVote = async (targetId: string) => {
    const { data } = await supabase.from('players').select('votes').eq('id', targetId).single();
    await supabase.from('players').update({ votes: (data?.votes || 0) + 1 }).eq('id', targetId);
    await updateRoomStatus(room.id, GameScreen.REVEAL as any);
  };

  const renderContent = () => {
    switch (screen) {
      case GameScreen.LOADING:
        return (
          <div className="flex flex-col items-center justify-center h-full px-12">
            <h1 className="text-4xl font-brand text-white tracking-[0.3em] mb-10 text-glow">MODERN OPS</h1>
            <div className="w-full max-w-xs space-y-4">
              <div className="loading-bar-container"><div className="loading-bar-fill" style={{ width: `${loadingProgress}%` }}></div></div>
              <p className="text-[9px] font-mono text-zinc-600 text-center uppercase tracking-widest animate-pulse">Estableciendo Uplink...</p>
            </div>
          </div>
        );
      case GameScreen.RECONNECT_PROMPT:
        return (
          <div className="flex flex-col h-full p-10 items-center justify-center text-center">
            <h2 className="text-5xl font-brand text-white mb-4 tracking-widest">¿RETOMAR MISIÓN?</h2>
            <p className="text-zinc-500 text-xs font-mono uppercase mb-12 max-w-[250px]">Detectada señal en nodo [{pendingSession?.room?.code}]</p>
            <div className="w-full max-w-xs space-y-4">
               <button onClick={confirmReconnect} className="btn-modern w-full py-6 rounded-3xl text-2xl">RECONECTAR</button>
               <button onClick={discardReconnect} className="w-full py-4 text-zinc-600 font-black tracking-widest uppercase">Nueva Op</button>
            </div>
          </div>
        );
      case GameScreen.MODE_SELECTION:
        return (
          <div className="flex flex-col h-full p-8 items-center justify-center">
            <h2 className="text-8xl font-brand text-white italic text-glow mb-20">CENTRAL</h2>
            <button onClick={() => { setIsLoading(true); getPublicRooms().then(setPublicRooms); changeScreen(GameScreen.ONLINE_SETUP); setIsLoading(false); }} className="glass-card w-full max-w-sm p-10 text-left">
              <h3 className="text-4xl font-brand text-white mb-2">OPERACIÓN ONLINE</h3>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest">Conexión Global</p>
            </button>
          </div>
        );
      case GameScreen.ONLINE_SETUP:
        return (
          <div className="flex flex-col h-full p-8 overflow-y-auto scrollbar-hide">
             <input type="text" placeholder="TU ALIAS" value={nameInput} onChange={e => setNameInput(e.target.value)} className="w-full bg-transparent border-b border-white/10 py-5 text-5xl font-brand text-white outline-none mb-12 uppercase" />
             <button onClick={async () => {
               if (!nameInput.trim()) return alert("Ingresa un Alias");
               const code = Math.random().toString(36).substring(2, 8).toUpperCase();
               const r = await createRoom(code);
               const p = await addPlayerToRoom(r.id, nameInput, null, true);
               setRoom(r); setMe(p as any);
               localStorage.setItem('last_room_id', r.id); localStorage.setItem('last_player_id', p.id);
               changeScreen(GameScreen.ONLINE_LOBBY);
             }} className="btn-modern w-full py-6 rounded-3xl text-2xl mb-4">CREAR NODO</button>
             <div className="flex gap-2">
                <input type="text" placeholder="CÓDIGO" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-white/5 rounded-3xl px-8 font-brand text-2xl text-white outline-none" />
                <button onClick={async () => {
                  if (!nameInput.trim()) return alert("Ingresa un Alias");
                  const r = await joinRoom(roomCodeInput);
                  if (!r) return alert("No existe");
                  const p = await addPlayerToRoom(r.id, nameInput, null, false);
                  setRoom(r); setMe(p as any);
                  localStorage.setItem('last_room_id', r.id); localStorage.setItem('last_player_id', p.id);
                  changeScreen(GameScreen.ONLINE_LOBBY);
                }} className="bg-white text-black px-8 py-4 rounded-3xl font-bold">UNIRSE</button>
             </div>
          </div>
        );
      case GameScreen.ONLINE_LOBBY:
        return (
          <div className="flex flex-col h-full p-10">
            <h2 className="text-5xl font-brand text-white mb-10">NODO: {room?.code}</h2>
            <div className="flex-1 grid grid-cols-2 gap-4">
              {players.map(p => (
                <div key={p.id} className="glass-card p-6 flex flex-col items-center">
                  <PlayerAvatar player={p} size="md" />
                  <p className="mt-4 font-bold text-xs uppercase text-center w-full truncate">{p.name}</p>
                </div>
              ))}
            </div>
            {me?.is_host && (
              <div className="mt-8 space-y-4">
                <select value={selectedTheme} onChange={e => setSelectedTheme(e.target.value)} className="w-full bg-zinc-900 border border-white/10 p-4 rounded-xl text-white outline-none font-bold uppercase tracking-widest text-xs">
                  {['Random', 'Animales', 'Vida Cotidiana', 'Comida', 'Deportes'].map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                </select>
                <button onClick={handleStartGameSequence} className="btn-modern w-full py-6 rounded-3xl text-2xl">INICIAR OPERACIÓN</button>
              </div>
            )}
          </div>
        );
      case GameScreen.ROLE_REVEAL:
        return (
          <div className="flex flex-col h-full p-12 items-center justify-center text-center">
            <p className="text-red-600 font-bold tracking-[0.5em] mb-4 uppercase">Identidad Asignada</p>
            <h2 className={`text-7xl font-brand mb-10 ${me?.role === 'Impostor' ? 'text-red-600 text-glow' : 'text-white'}`}>
              {me?.role === 'Impostor' ? 'IMPOSTOR' : 'AGENTE'}
            </h2>
            <div className="glass-card p-10 w-full mb-12">
              <p className="text-[10px] text-zinc-500 uppercase mb-4 tracking-widest">Objetivo Secreto</p>
              <h3 className="text-4xl font-mono font-bold tracking-tighter">
                {me?.role === 'Impostor' ? '--- ENCRIPTADO ---' : room?.secret_word?.toUpperCase()}
              </h3>
            </div>
            {me?.is_host && <button onClick={() => updateRoomStatus(room.id, GameScreen.ONLINE_GAMEPLAY as any)} className="btn-modern px-12 py-5 rounded-3xl text-xl">CONTINUAR</button>}
          </div>
        );
      case GameScreen.ONLINE_GAMEPLAY:
        const isMyTurn = players.findIndex(p => p.id === me?.id) === room?.current_turn_index;
        return (
          <div className="flex flex-col h-full">
            <div className="p-8 border-b border-white/5 flex justify-between items-center">
               <h2 className="text-2xl font-brand tracking-widest">Fase de Descripción</h2>
               <div className="bg-red-600/10 px-4 py-1 rounded-full text-[10px] text-red-600 font-bold uppercase">{players[room.current_turn_index]?.name} transmitiendo...</div>
            </div>
            <div className="flex-1 p-8 overflow-y-auto space-y-6">
              <div className="flex flex-col items-center">
                <PlayerAvatar player={players[room.current_turn_index]} size="lg" highlight={isMyTurn} />
                <p className="mt-4 text-zinc-500 font-mono text-[10px] uppercase tracking-widest">Agente de Turno</p>
              </div>
              {isMyTurn && (
                <div className="glass-card p-6 border-red-600/30">
                  <p className="text-[10px] text-zinc-500 mb-4 uppercase">Tu descripción (No digas la palabra):</p>
                  <textarea value={descInput} onChange={e => setDescInput(e.target.value)} className="w-full bg-transparent text-white font-mono text-xl outline-none resize-none h-24" placeholder="..." />
                  <button onClick={handleSendDescription} className="btn-modern w-full py-4 rounded-xl mt-4">TRANSMITIR</button>
                </div>
              )}
            </div>
          </div>
        );
      case GameScreen.VOTING:
        return (
          <div className="flex flex-col h-full p-10">
            <h2 className="text-5xl font-brand text-white mb-2 tracking-widest">VOTACIÓN</h2>
            <p className="text-[10px] text-zinc-500 uppercase mb-10">¿Quién es el infiltrado?</p>
            <div className="grid grid-cols-1 gap-4 overflow-y-auto">
              {players.map(p => (
                <button key={p.id} onClick={() => handleVote(p.id)} className="glass-card p-6 flex items-center justify-between hover:border-red-600 transition-all">
                  <div className="flex items-center gap-4">
                    <PlayerAvatar player={p} size="sm" />
                    <span className="font-bold uppercase tracking-widest truncate w-32 text-left">{p.name}</span>
                  </div>
                  <span className="text-[10px] text-zinc-600 font-black">SELECCIONAR</span>
                </button>
              ))}
            </div>
          </div>
        );
      case GameScreen.REVEAL:
        const impostor = players.find(p => p.role === 'Impostor');
        return (
          <div className="flex flex-col h-full p-12 items-center justify-center text-center">
            <h2 className="text-7xl font-brand text-white mb-4">MISIÓN FINALIZADA</h2>
            <div className="glass-card p-12 w-full mb-12 border-red-600">
               <p className="text-[10px] text-zinc-500 mb-4 uppercase">El Infiltrado era:</p>
               <PlayerAvatar player={impostor!} size="lg" />
               <h3 className="text-4xl font-brand text-red-600 mt-6 tracking-[0.2em]">{impostor?.name?.toUpperCase()}</h3>
               <p className="mt-8 text-white font-mono text-xl">Palabra: {room?.secret_word}</p>
            </div>
            <button onClick={() => updateRoomStatus(room.id, GameScreen.ONLINE_LOBBY as any)} className="btn-modern px-12 py-5 rounded-3xl text-xl">VOLVER AL NODO</button>
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
