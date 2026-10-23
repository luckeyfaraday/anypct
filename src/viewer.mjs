import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);

// Worker exceptions do not become page errors in the upstream renderer.
// Keep a small diagnostic surface so browser checks can detect missing terrain.
const diagnostics=`
window.benchViewer={errors:[],sections:{},workers:0};
const NativeWorker=window.Worker;
window.Worker=class extends NativeWorker {
  constructor(...args){
    super(...args);window.benchViewer.workers++;
    this.addEventListener('error',event=>{
      const message=event.message||'Worker failed without an ErrorEvent message';
      window.benchViewer.errors.push(message);
      console.error('Terrain worker: '+message);
    });
    this.addEventListener('message',({data})=>{
      if(data.type==='geometry')window.benchViewer.sections[data.key]=data.geometry.positions.length/3;
      if(data.type==='benchError'){window.benchViewer.errors.push(data.message);console.error('Terrain worker: '+data.message);}
    });
  }
};
`;

// Read-only observer of the bot's protocol world, not the agent's input feed.
// Unlike the upstream convenience launcher, this binds only to loopback and
// does not forward any click events to the bot.
export async function startViewer(session,{port=0}={}){
  const express=require('express');const {Server}=require('socket.io');
  // Import only the server world stream; the package barrel also imports a
  // headless renderer with an unnecessary native canvas dependency.
  const {WorldView}=require('prismarine-viewer/viewer/lib/worldView');
  const {setupRoutes}=require('prismarine-viewer/lib/common');
  const app=express(),server=http.createServer(app),io=new Server(server);
  const browserSource=await fs.readFile(require.resolve('prismarine-viewer/public/index.js'),'utf8');
  app.get('/index.js',(_req,res)=>res.type('js').send(diagnostics+browserSource));
  const workerSource=await fs.readFile(require.resolve('prismarine-viewer/public/worker.js'),'utf8');
  app.get('/worker.js',(_req,res)=>res.type('js').send(`self.addEventListener('error',e=>self.postMessage({type:'benchError',message:String(e.message),stack:e.error?.stack}));\n`+workerSource));
  setupRoutes(app,'');
  io.on('connection',socket=>{
    const bot=session.bot;socket.emit('version',bot.version);
    const view=new WorldView(bot.world,4,bot.entity.position,socket);
    view.init(bot.entity.position).then(()=>session.log.event('viewer_ready',{chunks:Object.keys(view.loadedChunks).length})).catch(error=>session.log.event('viewer_error',{message:error.message}));view.listenToBot(bot);
    const move=()=>{socket.emit('position',{pos:bot.entity.position,yaw:bot.entity.yaw,pitch:bot.entity.pitch,addMesh:true});view.updatePosition(bot.entity.position);};
    const unload=p=>view.unloadChunk(p);
    bot.on('chunkColumnUnload',unload);
    bot.on('move',move);move();socket.on('disconnect',()=>{bot.off('move',move);bot.off('chunkColumnUnload',unload);view.removeListenersFromBot(bot);});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  session.viewerUrl=`http://127.0.0.1:${server.address().port}`;
  session.closeViewer=async()=>{server.closeIdleConnections();await io.close();};
  return session.viewerUrl;
}
