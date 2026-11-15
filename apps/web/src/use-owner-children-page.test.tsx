import { requiredValue } from "./test-value.js";
import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {useOwnerChildrenPage} from "./use-owner-children-page.js";
import {api} from "./api.js";
import type {Resource} from "./types.js";
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const rows=(count:number,prefix="item")=>Array.from({length:count},(_,n)=>({id:prefix+String(n),name:prefix+String(n),type:"file"} as Resource));
describe("bounded owner catalog page",()=>{
 it("requests one500-row page, preserves order, and rejects invalid offsets or oversized responses",async()=>{
  const values=rows(500),fetch=vi.fn(async()=>Response.json(values));vi.stubGlobal("fetch",fetch);
  const page=await api.childrenPage("folder",0);expect(page.items).toEqual(values);expect(page.nextOffset).toBe(500);expect(fetch).toHaveBeenCalledTimes(1);
  await expect(api.childrenPage("folder",-1)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(Response.json(rows(501)));await expect(api.childrenPage("folder",500)).rejects.toThrow();
 });
 it("keeps only the current page and permits previous from an empty trailing page",async()=>{
  const calls=vi.spyOn(api,"childrenPage").mockResolvedValueOnce({items:rows(500),nextOffset:500}).mockResolvedValueOnce({items:[],nextOffset:null}).mockResolvedValueOnce({items:rows(500),nextOffset:500});
  const {result}=renderHook(()=>useOwnerChildrenPage("root"));
  await act(async()=>{await result.current.load("folder");});expect(result.current.items).toHaveLength(500);
  await act(async()=>{await result.current.next();});expect(result.current.items).toHaveLength(0);expect(result.current.offset).toBe(500);expect(result.current.nextOffset).toBeNull();
  await act(async()=>{await result.current.previous();});expect(result.current.items).toHaveLength(500);expect(result.current.offset).toBe(0);expect(calls.mock.calls.map(c=>c[1])).toEqual([0,500,0]);
 });
 it("aborts and ignores an old page reply after navigation, even when fetch ignores abort",async()=>{
  let reply!:(value:{items:readonly Resource[];nextOffset:null})=>void;
  const pending=new Promise<{items:readonly Resource[];nextOffset:null}>(resolve=>{reply=resolve;});
  const calls=vi.spyOn(api,"childrenPage").mockReturnValueOnce(pending).mockResolvedValueOnce({items:rows(1,"new"),nextOffset:null});
  const {result,rerender}=renderHook(({scope})=>useOwnerChildrenPage(scope),{initialProps:{scope:"old"}});
  let old!:Promise<boolean>;act(()=>{old=result.current.load("old-folder");});rerender({scope:"new"});
  await act(async()=>{await result.current.load("new-folder");});expect(requiredValue(requiredValue(calls.mock.calls[0])[2]).aborted).toBe(true);
  await act(async()=>{reply({items:rows(500,"stale"),nextOffset:null});await old;});expect(result.current.items.map(i=>i.name)).toEqual(["new0"]);expect(result.current.parentId).toBe("new-folder");
 });
 it("drops a superseded same-folder page response and never lets it clear a newer loading state",async()=>{
  let finish!:(value:{items:readonly Resource[];nextOffset:null})=>void;
  vi.spyOn(api,"childrenPage").mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({items:rows(1,"current"),nextOffset:null});
  const {result}=renderHook(()=>useOwnerChildrenPage("same"));let old!:Promise<boolean>;
  act(()=>{old=result.current.load("folder",500);});await act(async()=>{await result.current.load("folder",0);});
  await act(async()=>{finish({items:rows(1,"late"),nextOffset:null});await old;});expect(requiredValue(result.current.items[0]).name).toBe("current0");expect(result.current.offset).toBe(0);expect(result.current.loading).toBe(false);
 });
 it("an aborted external path request cannot cancel or overwrite the current page",async()=>{
  vi.spyOn(api,"childrenPage").mockResolvedValue({items:rows(1),nextOffset:null});const {result}=renderHook(()=>useOwnerChildrenPage("current"));
  await act(async()=>{await result.current.load("folder");});const cancelled=new AbortController();cancelled.abort();
  await act(async()=>{expect(await result.current.load("old",0,cancelled.signal)).toBe(false);});expect(result.current.parentId).toBe("folder");
 });
});

