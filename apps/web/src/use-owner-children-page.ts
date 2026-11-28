import {useEffect,useRef,useState} from "react";
import {api} from "./api.js";
import type {Resource} from "./types.js";
interface Page {readonly scope:string;readonly parentId:string|undefined;readonly items:readonly Resource[];readonly offset:number;readonly nextOffset:number|null}
const empty=(scope:string):Page=>({scope,parentId:undefined,items:[],offset:0,nextOffset:null});
export function useOwnerChildrenPage(scope:string){
 const [saved,setPage]=useState<Page>(()=>empty(scope)),[busy,setBusy]=useState(false);
 const active=useRef<AbortController|undefined>(undefined),currentScope=useRef(scope);currentScope.current=scope;
 useEffect(()=>{setPage(empty(scope));setBusy(false);return()=>{active.current?.abort();};},[scope]);
 const page=saved.scope===scope?saved:empty(scope);
 const load=async(parentId:string,offset=0,signal?:AbortSignal):Promise<boolean>=>{
  if(currentScope.current!==scope||signal?.aborted)return false;
  active.current?.abort();const controller=new AbortController();active.current=controller;
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener("abort",abort,{once:true});
  setBusy(true);setPage({...empty(scope),parentId,offset});
  try{
   const result=await api.childrenPage(parentId,offset,controller.signal);
   if(controller.signal.aborted||currentScope.current!==scope||active.current!==controller)return false;
   setPage({scope,parentId,offset,items:result.items,nextOffset:result.nextOffset});return true;
  }catch(error){if(controller.signal.aborted||currentScope.current!==scope)return false;throw error;}
  finally{signal?.removeEventListener("abort",abort);if(active.current===controller&&currentScope.current===scope)setBusy(false);}
 };
 return {...page,loading:busy&&currentScope.current===scope,load,
  next:()=>page.parentId===undefined||page.nextOffset===null?Promise.resolve(false):load(page.parentId,page.nextOffset),
  previous:()=>page.parentId===undefined||page.offset===0?Promise.resolve(false):load(page.parentId,Math.max(0,page.offset-500)),
 };
}
