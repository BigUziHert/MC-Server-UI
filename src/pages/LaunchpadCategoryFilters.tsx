import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Filter, X } from "lucide-react";
import {
  modCategories,
  supportsCategory,
} from "../../shared/launchpad-categories.mjs";

export default function LaunchpadCategoryFilters({
  selected,
  platform,
  onChange,
}: {
  selected: string[];
  platform?: string;
  onChange: (categories: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  function row(category: { id: string; label: string }, child = false) {
    const supported = !platform || supportsCategory(category.id, platform);
    const checked = selected.includes(category.id);
    return (
      <label
        className={`launchpad-category-choice${child ? " child" : ""}`}
        title={
          !supported
            ? "This category is not available on this platform."
            : category.label
        }
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!supported || (!checked && selected.length >= 10)}
          onChange={() =>
            onChange(
              checked
                ? selected.filter((id) => id !== category.id)
                : [...selected, category.id],
            )
          }
        />
        <span>{category.label}</span>
      </label>
    );
  }
  return (
    <div className="launchpad-category-filters" ref={root}>
      <button
        type="button"
        className={`btn${selected.length ? " launchpad-filter-selected" : ""}`}
        ref={trigger}
        aria-expanded={open}
        aria-controls="launchpad-category-panel"
        onClick={() => setOpen(!open)}
      >
        <Filter size={15} /> Filters
        {selected.length ? ` / ${selected.length}` : ""}
      </button>
      {open && (
        <section
          id="launchpad-category-panel"
          className="panel launchpad-category-panel"
          aria-label="Category filters"
        >
          <div className="launchpad-category-heading">
            <strong>Categories</strong>
            {selected.length > 0 && (
              <button
                className="btn"
                type="button"
                onClick={() => onChange([])}
              >
                Clear
              </button>
            )}
            <button
              className="btn icon"
              type="button"
              aria-label="Close filters"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={15} />
            </button>
          </div>
          <p>Match any selected category.</p>
          <div className="launchpad-category-list">
            {modCategories.map((category) => (
              <div key={category.id}>
                <div className="launchpad-category-row">
                  {row(category)}
                  {category.children?.length ? (
                    <button
                      className="btn icon"
                      type="button"
                      aria-label={`${expanded.has(category.id) ? "Collapse" : "Expand"} ${category.label}`}
                      aria-expanded={expanded.has(category.id)}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(category.id)) next.delete(category.id);
                          else next.add(category.id);
                          return next;
                        })
                      }
                    >
                      {expanded.has(category.id) ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                    </button>
                  ) : null}
                </div>
                {expanded.has(category.id) &&
                  category.children?.map((child) => (
                    <div key={child.id}>{row(child, true)}</div>
                  ))}
              </div>
            ))}
          </div>
          {platform && platform !== "curseforge" && (
            <p>Unavailable categories are dimmed for this platform.</p>
          )}
          {selected.length >= 10 && <p>Up to 10 categories can be selected.</p>}
        </section>
      )}
    </div>
  );
}
