import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Folder,
  HardDrive,
  LoaderCircle,
  X,
} from "lucide-react";
import { api, messageOf } from "./api";
import "./host-directory-picker.css";

type Listing = {
  directory: string | null;
  parent: string | null;
  separator: string;
  folders: { name: string; path: string }[];
  truncated: boolean;
};

export default function HostDirectoryPicker({
  initialDirectory,
  onSelect,
  onClose,
}: {
  initialDirectory: string;
  onSelect: (directory: string) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null>(
    initialDirectory.trim() || null,
  );
  const [listing, setListing] = useState<Listing | null>(null);
  const [address, setAddress] = useState(initialDirectory);
  const [newFolder, setNewFolder] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const navigation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const generation = navigation.current;
    const current = () =>
      !controller.signal.aborted && generation === navigation.current;
    void api<Listing>(
      `/server-setup/directories${target ? `?${new URLSearchParams({ directory: target })}` : ""}`,
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      },
    )
      .then((result) => {
        if (!current()) return;
        setListing(result);
        setAddress(result.directory || "");
      })
      .catch((cause) => {
        if (current())
          setError(messageOf(cause, "This folder could not be opened."));
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => controller.abort();
  }, [target, refresh]);
  const navigate = (directory: string | null) => {
    // Invalidate the displayed folder in the same event as navigation. A
    // passive-effect reset leaves its name input usable briefly and can erase
    // a name entered before the next listing arrives.
    navigation.current++;
    setLoading(true);
    setError("");
    setListing(null);
    setNewFolder("");
    setTarget(directory);
    setRefresh((value) => value + 1);
  };
  const invalidName = Boolean(
    newFolder &&
    (/[<>:"/\\|?*\x00-\x1f]/.test(newFolder) ||
      /[ .]$/.test(newFolder) ||
      /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
        newFolder,
      )),
  );
  const selected = listing?.directory
    ? newFolder
      ? `${listing.directory.replace(/[\\/]$/, "")}${listing.separator}${newFolder}`
      : listing.directory
    : "";
  return (
    <section
      className="host-folder-picker"
      aria-labelledby="host-folder-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="host-folder-heading">
        <div>
          <h3 id="host-folder-title" ref={heading} tabIndex={-1}>
            Choose installation folder
          </h3>
          <p>Folders on the computer running MC Panel</p>
        </div>
        <button
          type="button"
          className="btn icon"
          aria-label="Close folder browser"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="host-folder-navigation">
        <button type="button" className="btn" onClick={() => navigate(null)}>
          <HardDrive size={15} /> Drives
        </button>
        <button
          type="button"
          className="btn"
          disabled={loading || !listing?.directory}
          onClick={() => navigate(listing?.parent || null)}
        >
          <ArrowUp size={15} /> Up
        </button>
      </div>
      <label className="host-folder-address" htmlFor="host-folder-address">
        Folder path
      </label>
      <div className="host-folder-address-row">
        <input
          id="host-folder-address"
          value={address}
          placeholder="Enter a folder path"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              navigate(address.trim() || null);
            }
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => navigate(address.trim() || null)}
        >
          Open
        </button>
      </div>
      <div
        className="host-folder-list"
        aria-label="Available folders"
        aria-busy={loading}
      >
        {loading ? (
          <p role="status">
            <LoaderCircle size={17} className="spin" /> Loading folders…
          </p>
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="btn"
              onClick={() => navigate(target)}
            >
              Retry
            </button>
          </div>
        ) : listing?.folders.length ? (
          listing.folders.map((folder) => (
            <button
              key={folder.path}
              type="button"
              className="host-folder-row"
              onClick={() => navigate(folder.path)}
            >
              {listing.directory ? (
                <Folder size={18} />
              ) : (
                <HardDrive size={18} />
              )}
              <span>{folder.name}</span>
              <ChevronRight size={16} />
            </button>
          ))
        ) : (
          <p>
            {listing?.directory
              ? "No subfolders. You can use this folder or name a new folder below."
              : "No available drives were found. Enter a folder path above."}
          </p>
        )}
      </div>
      {listing?.truncated && (
        <p className="host-folder-note">
          This folder contains more entries than can be shown. Open a folder by
          entering its full path above.
        </p>
      )}
      {listing?.directory && !loading && !error && (
        <>
          <label className="host-folder-address" htmlFor="host-new-folder">
            New folder name (optional)
          </label>
          <input
            id="host-new-folder"
            value={newFolder}
            placeholder="For example, Survival"
            onChange={(event) => setNewFolder(event.target.value)}
            aria-invalid={invalidName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          {invalidName && (
            <p role="alert" className="host-folder-note">
              Enter a valid folder name without path separators or reserved
              characters.
            </p>
          )}
          <p className="host-folder-selected">{selected}</p>
          <p className="host-folder-note">
            The installation folder must be empty. A new folder is created only
            after you confirm installation.
          </p>
        </>
      )}
      <div className="host-folder-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={loading || !selected || invalidName || !!error}
          onClick={() => onSelect(selected)}
        >
          {newFolder ? "Use new folder" : "Use this folder"}
        </button>
      </div>
    </section>
  );
}
