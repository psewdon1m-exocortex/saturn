import type { InputHTMLAttributes } from "react";

// HTML single-line controls strip CR/LF. Use equal-length masked display units
// while keeping the pasted credential exact in transient memory.
export function displayOpaqueKey(raw: string): string { return raw.replace(/[\r\n]/g,"•"); }
export function editOpaqueKey(raw: string, displayed: string): string {
  const previous=displayOpaqueKey(raw);
  let prefix=0,suffix=0;
  while(prefix<previous.length&&prefix<displayed.length&&previous[prefix]===displayed[prefix])prefix++;
  while(suffix<previous.length-prefix&&suffix<displayed.length-prefix&&previous[previous.length-1-suffix]===displayed[displayed.length-1-suffix])suffix++;
  return raw.slice(0,prefix)+displayed.slice(prefix,displayed.length-suffix)+raw.slice(raw.length-suffix);
}
export function pasteOpaqueKey(input: HTMLInputElement, raw: string, text: string): string {
  const start=input.selectionStart??raw.length,end=input.selectionEnd??start;
  return raw.slice(0,start)+text+raw.slice(end);
}
export function OpaqueKeyInput({value,onValue,...props}: Omit<InputHTMLAttributes<HTMLInputElement>,"value"|"onChange"|"onPaste"> & {value:string;onValue:(value:string)=>void}) {
  return <input {...props} value={displayOpaqueKey(value)} onChange={event=>onValue(editOpaqueKey(value,event.target.value))} onPaste={event=>{event.preventDefault();onValue(pasteOpaqueKey(event.currentTarget,value,event.clipboardData.getData("text")));}} />;
}
