import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DOCUMENTATION_REVISION, DOCUMENTATION_SECTIONS, filterDocumentation } from "./documentation-sections.js";

const GROUPS = ["Get Started", "Operate", "Maintain"] as const;
const READING_OFFSET = 30;

export function DocumentationPage() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(DOCUMENTATION_SECTIONS[0]?.id ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const visibleSections = useMemo(() => filterDocumentation(query), [query]);

  const synchronizeCurrent = useCallback(() => {
    const owner = articleRef.current;
    if (!owner || !visibleSections.length) { setActiveId(""); return; }
    let next = visibleSections[0]?.id ?? "";
    const top = owner.getBoundingClientRect().top + owner.clientTop;
    for (const section of visibleSections) {
      const target = owner.querySelector<HTMLElement>(`#${section.id}`);
      if (!target || target.getBoundingClientRect().top > top + READING_OFFSET + 1) break;
      next = section.id;
    }
    if (owner.scrollHeight > owner.clientHeight && owner.scrollTop >= owner.scrollHeight - owner.clientHeight - 1) {
      next = visibleSections.at(-1)?.id ?? next;
    }
    setActiveId(current => current === next ? current : next);
  }, [visibleSections]);

  useLayoutEffect(() => {
    const article = articleRef.current;
    const navigation = navigationRef.current;
    if (article) article.scrollTop = 0;
    if (navigation) navigation.scrollTop = Math.min(navigation.scrollTop, Math.max(0, navigation.scrollHeight - navigation.clientHeight));
    synchronizeCurrent();
  }, [visibleSections, synchronizeCurrent]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(synchronizeCurrent);
    if (articleRef.current) observer.observe(articleRef.current);
    if (guideRef.current) observer.observe(guideRef.current);
    return () => observer.disconnect();
  }, [synchronizeCurrent]);

  const changeQuery = (value: string) => {
    if (articleRef.current) articleRef.current.scrollTop = 0;
    setQuery(value);
  };
  const clearQuery = () => {
    changeQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const navigate = (id: string) => {
    const owner = articleRef.current;
    const target = owner?.querySelector<HTMLElement>(`#${id}`);
    if (!owner || !target) return;
    owner.scrollTo({
      top: Math.max(0, target.getBoundingClientRect().top - owner.getBoundingClientRect().top - owner.clientTop + owner.scrollTop - READING_OFFSET),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    synchronizeCurrent();
  };

  return <section className="workspace documentation-workspace" aria-labelledby="documentation-title">
    <header className="workspace__head"><h1 className="page-title" id="documentation-title">Documentation</h1></header>
    <div className="documentation-inset">
      <div className="documentation-page">
        <nav ref={navigationRef} className="documentation-nav" aria-label="Documentation navigation" tabIndex={0}>
          <div className="documentation-nav-inner">
            <div className="documentation-search">
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
              <input ref={inputRef} type="search" aria-label="Search documentation" placeholder="Search documentation" value={query}
                onChange={event => changeQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); clearQuery(); } }} />
              <button type="button" className="documentation-search-clear" aria-label="Clear search" aria-hidden={!query} disabled={!query} tabIndex={query ? 0 : -1} onClick={clearQuery}>
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            {GROUPS.map(group => {
              const sections = visibleSections.filter(section => section.group === group);
              return sections.length ? <div className="documentation-nav-group" key={group}>
                <strong>{group}</strong>
                {sections.map(section => <button type="button" className="documentation-link" key={section.id} aria-controls={section.id}
                  aria-current={activeId === section.id ? "location" : undefined} onClick={() => navigate(section.id)}>{section.title}</button>)}
              </div> : null;
            })}
          </div>
        </nav>
        <div ref={articleRef} className="documentation-article" role="region" aria-label="Saturn operator guide" tabIndex={0} onScroll={synchronizeCurrent}>
          <div ref={guideRef}>
            <header className="documentation-guide-header">
              <span className="documentation-kicker">Saturn / Operator guide / {DOCUMENTATION_REVISION}</span>
              <h2>Files, backups and recovery</h2>
              <p>Use the current Saturn workspace, connect scoped producers and verify stored files. This guide describes prerequisites, failure states and the limits of each recovery path.</p>
            </header>
            {visibleSections.map(section => <article id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}>
              <h2 id={`${section.id}-title`}>{section.title}</h2>
              <p className="documentation-summary">{section.summary}</p>
              {section.content}
            </article>)}
            {!visibleSections.length ? <p className="documentation-empty" role="status">No documentation matches this search. Clear the query or try another term.</p> : null}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
