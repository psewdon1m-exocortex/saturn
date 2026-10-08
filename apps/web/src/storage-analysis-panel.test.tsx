import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageAnalysisPanel } from "./storage-analysis-panel.js";
import type { StorageAnalysisJob, StorageAnalysisReport } from "./types.js";

afterEach(()=>{cleanup();vi.unstubAllGlobals();document.cookie='vault_csrf_dev=; Max-Age=0';});
const job:StorageAnalysisJob={id:'00000000-0000-4000-8000-000000000010',profileId:'bootstrap',profileRevision:1,state:'ready',
  scannedEntries:3,scannedBytes:6,currentPath:null,counts:{added:1,changed:0,missing:1,blocked:0},failureCode:null,
  createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),completedAt:new Date(0).toISOString(),canSynchronize:true};
const report:StorageAnalysisReport={job,items:[{kind:'added',storagePath:'sync/new.txt',reason:'not_in_catalog',previousBytes:null,actualBytes:3},
  {kind:'missing',storagePath:'sync/old.txt',reason:'not_on_storage',previousBytes:3,actualBytes:null}],offset:0,hasMore:false};
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const requestUrl=(input:RequestInfo|URL)=>typeof input==='string'?input:input instanceof URL?input.href:input.url;
describe('Storage connection analysis and synchronization',()=>{
  it('starts an analysis, displays the report, and requires confirmation before the CSRF-protected synchronization',async()=>{
    let current:StorageAnalysisReport={job:null,items:[],offset:0,hasMore:false};
    const fetchMock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=requestUrl(input);
      if(init?.method==='POST'&&url.endsWith('/synchronize')){current={...report,job:{...job,state:'synchronized',canSynchronize:false}};return json(current.job);}
      if(init?.method==='POST'){current=report;return json({...job,state:'queued'});}
      return json(current);
    });
    vi.stubGlobal('fetch',fetchMock);document.cookie=`vault_csrf_dev=${'a'.repeat(43)}`;
    render(<StorageAnalysisPanel profileId="bootstrap" profileRevision={1} disabled={false} addNotice={vi.fn()}/>);
    await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button',{name:'Analyze storage'}));
    await screen.findByText('sync/new.txt');expect(screen.getByText('sync/old.txt')).toBeTruthy();
    const synchronize=screen.getByRole('button',{name:'Synchronize catalog'});
    expect(synchronize).toHaveProperty('disabled',true);
    expect(fetchMock.mock.calls.some(call=>requestUrl(call[0]).endsWith('/synchronize'))).toBe(false);
    fireEvent.click(screen.getByRole('checkbox',{name:'Apply the reported changes to the catalog'}));
    fireEvent.click(synchronize);
    await screen.findByText('Catalog changes were applied. File bytes were preserved.');
    const request=fetchMock.mock.calls.find(call=>requestUrl(call[0]).endsWith('/synchronize'));
    const body=request?.[1]?.body;
    if(typeof body!=='string')throw new Error('Synchronization body is absent');
    expect(JSON.parse(body)).toEqual({confirmation:'SYNCHRONIZE CATALOG'});
    expect(new Headers(request?.[1]?.headers).get('X-Vault-CSRF')).toBe('a'.repeat(43));
    expect(fetchMock.mock.calls.some(call=>requestUrl(call[0]).includes('reauthenticate'))).toBe(false);
  });
  it('restores a saved report after returning to the page',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>json(report)));
    render(<StorageAnalysisPanel disabled={false} addNotice={vi.fn()}/>);
    expect(await screen.findByText(/Analysis report/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Analysis report/));
    expect(screen.getByText('sync/new.txt')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Synchronize catalog'})).toHaveProperty('disabled',true);
  });
  it('shows blocked paths and never offers to apply an incomplete report',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>json({...report,job:{...job,counts:{added:0,changed:0,missing:0,blocked:1},canSynchronize:false},
      items:[{kind:'blocked',storagePath:'root.txt',reason:'file_in_storage_root',previousBytes:null,actualBytes:null}]})));
    render(<StorageAnalysisPanel disabled={false} addNotice={vi.fn()}/>);
    await screen.findByText('Resolve the blocked entries and analyze again before synchronizing.');
    expect(screen.queryByRole('button',{name:'Synchronize catalog'})).toBeNull();
  });
  it('reports a stale analysis and keeps synchronization unavailable',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>json({...report,job:{...job,state:'stale',failureCode:'storage_analysis_stale',canSynchronize:false}})));
    render(<StorageAnalysisPanel disabled={false} addNotice={vi.fn()}/>);
    await screen.findByText('The storage or catalog changed after analysis. Analyze again before synchronizing.');
    expect(screen.queryByRole('button',{name:'Synchronize catalog'})).toBeNull();
  });
});
