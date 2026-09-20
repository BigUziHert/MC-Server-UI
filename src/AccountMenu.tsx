import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronUp, LoaderCircle } from "lucide-react";
import "./account-menu.css";

export type AccountMenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  busy?: boolean;
};

export type AccountMenuProps = {
  identity: { name: string; detail: string; initial?: string };
  actions: AccountMenuAction[];
  status?: { label: string; tone?: "active" | "neutral" };
};

export default function AccountMenu({
  identity,
  actions,
  status,
}: AccountMenuProps) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const initial =
    identity.initial || identity.name.trim().charAt(0).toUpperCase();

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  function enabledItems() {
    return Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) || [],
    );
  }

  useLayoutEffect(() => {
    if (!open) return;
    function placeMenu() {
      const anchor = trigger.current?.getBoundingClientRect();
      const popover = menu.current?.getBoundingClientRect();
      if (!anchor || !popover) return;
      const above = anchor.top - popover.height - 8;
      const below = anchor.bottom + 8;
      setPosition({
        left: Math.max(
          8,
          Math.min(anchor.left + 12, window.innerWidth - popover.width - 8),
        ),
        top: Math.max(
          8,
          Math.min(
            above >= 8 ? above : below,
            window.innerHeight - popover.height - 8,
          ),
        ),
      });
    }
    placeMenu();
    const items = enabledItems();
    (focusLast.current ? items.at(-1) : items[0])?.focus();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent | FocusEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !menu.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  function menuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // Resume the sidebar's tab order from the trigger, even though the menu is a portal.
      close(true);
      return;
    }
    const items = enabledItems();
    if (!items.length) return;
    const index = items.findIndex((item) => item === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % items.length;
        break;
      case "ArrowUp":
        next = (index - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="account-menu">
      <button
        ref={trigger}
        type="button"
        className="profile account-menu-trigger"
        aria-label={`Account menu for ${identity.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          focusLast.current = false;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusLast.current = event.key === "ArrowUp";
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <span className="avatar account-menu-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="account-menu-identity">
          <strong>{identity.name}</strong>
          <small>{identity.detail}</small>
        </span>
        <ChevronUp
          size={15}
          className="account-menu-chevron"
          aria-hidden="true"
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Account"
            className="account-menu-popover"
            style={position}
            onKeyDown={menuKeyDown}
          >
            <div className="account-menu-heading" role="presentation">
              <span className="account-menu-eyebrow">Account</span>
              <strong>{identity.name}</strong>
              <p>{identity.detail}</p>
              {status && (
                <span className="account-menu-status">
                  <span
                    className={`account-menu-status-dot ${status.tone || "neutral"}`}
                    aria-hidden="true"
                  />
                  {status.label}
                </span>
              )}
            </div>
            <div className="account-menu-actions" role="presentation">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="account-menu-action"
                  disabled={action.disabled || action.busy}
                  aria-busy={action.busy || undefined}
                  onClick={() => {
                    close(true);
                    action.onSelect();
                  }}
                >
                  {action.busy ? (
                    <LoaderCircle
                      size={16}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    action.icon && (
                      <span
                        className="account-menu-action-icon"
                        aria-hidden="true"
                      >
                        {action.icon}
                      </span>
                    )
                  )}
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
