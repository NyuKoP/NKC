import { CloseIcon, CopyIcon, EditIcon } from "./icons/Icons";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onCopyAccountId: () => void;
  displayName: string;
  accountId: string;
};

const settingsMenu = [
  "후원하기",
  "경로",
  "Session Network",
  "개인정보 보호",
  "알림",
  "대화",
  "디자인",
  "메시지 요청",
  "Preferences",
];

const SettingsModal = ({
  isOpen,
  onClose,
  onCopyAccountId,
  displayName,
  accountId,
}: SettingsModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-header">
          <div className="modal-title">
            <h2>설정</h2>
            <button
              type="button"
              className="icon-button ghost"
              aria-label="Edit"
            >
              <EditIcon width={18} height={18} />
            </button>
          </div>
          <button
            type="button"
            className="icon-button ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </div>
        <div className="modal-profile">
          <div className="avatar large">
            <span>TS</span>
            <span className="qr-badge">QR</span>
          </div>
          <div className="modal-profile-info">
            <span className="label">Display name</span>
            <strong>{displayName}</strong>
          </div>
        </div>
        <div className="modal-account">
          <div>
            <span className="label">Your Account ID</span>
            <div className="fingerprint">{accountId}</div>
          </div>
          <button
            type="button"
            className="icon-button accent"
            onClick={onCopyAccountId}
          >
            <CopyIcon width={16} height={16} />
            Copy
          </button>
        </div>
        <div className="modal-menu">
          {settingsMenu.map((item) => (
            <button key={item} type="button" className="menu-item">
              <span>{item}</span>
              <span className="menu-placeholder">...</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
