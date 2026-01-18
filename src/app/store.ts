import { create } from "zustand";
import type { Conversation, Message, UserProfile } from "../db/repo";
import { createId } from "../utils/ids";

export type UiMode = "locked" | "onboarding" | "app";
export type RightTab = "about" | "media" | "settings";
export type ListMode = "chats" | "friends";
export type ListFilter = "all" | "unread" | "favorites";
export type Language = "ko" | "en";

export type Toast = {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export type ConfirmState = {
  title: string;
  message: string;
  onConfirm: () => void;
} | null;

export type AppState = {
  ui: {
    mode: UiMode;
    selectedConvId: string | null;
    isComposing: boolean;
    rightPanelOpen: boolean;
    rightTab: RightTab;
    listMode: ListMode;
    listFilter: ListFilter;
    search: string;
    language: Language;
    toast: Toast[];
    confirm: ConfirmState;
  };
  session: {
    unlocked: boolean;
    vkInMemory: boolean;
  };
  userProfile: UserProfile | null;
  friends: UserProfile[];
  convs: Conversation[];
  messagesByConv: Record<string, Message[]>;
  setMode: (mode: UiMode) => void;
  setSelectedConv: (id: string | null) => void;
  setIsComposing: (value: boolean) => void;
  setRightPanelOpen: (value: boolean) => void;
  setRightTab: (tab: RightTab) => void;
  setListMode: (mode: ListMode) => void;
  setListFilter: (value: ListFilter) => void;
  setSearch: (value: string) => void;
  setLanguage: (value: Language) => void;
  setSession: (value: Partial<AppState["session"]>) => void;
  setData: (payload: {
    user: UserProfile | null;
    friends: UserProfile[];
    convs: Conversation[];
    messagesByConv: Record<string, Message[]>;
  }) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  setConfirm: (confirm: ConfirmState) => void;
};

const getInitialLanguage = (): Language => {
  if (typeof window === "undefined") return "ko";
  const value = window.localStorage.getItem("nkc.lang");
  return value === "en" ? "en" : "ko";
};

export const useAppStore = create<AppState>((set) => ({
  ui: {
    mode: "onboarding",
    selectedConvId: null,
    isComposing: false,
    rightPanelOpen: false,
    rightTab: "about",
    listMode: "friends",
    listFilter: "all",
    search: "",
    language: getInitialLanguage(),
    toast: [],
    confirm: null,
  },
  session: {
    unlocked: false,
    vkInMemory: false,
  },
  userProfile: null,
  friends: [],
  convs: [],
  messagesByConv: {},
  setMode: (mode) => set((state) => ({ ui: { ...state.ui, mode } })),
  setSelectedConv: (id) =>
    set((state) => ({ ui: { ...state.ui, selectedConvId: id } })),
  setIsComposing: (value) =>
    set((state) => ({ ui: { ...state.ui, isComposing: value } })),
  setRightPanelOpen: (value) =>
    set((state) => ({ ui: { ...state.ui, rightPanelOpen: value } })),
  setRightTab: (tab) =>
    set((state) => ({ ui: { ...state.ui, rightTab: tab } })),
  setListMode: (mode) =>
    set((state) => ({ ui: { ...state.ui, listMode: mode } })),
  setListFilter: (value) =>
    set((state) => ({ ui: { ...state.ui, listFilter: value } })),
  setSearch: (value) =>
    set((state) => ({ ui: { ...state.ui, search: value } })),
  setLanguage: (value) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nkc.lang", value);
    }
    set((state) => ({ ui: { ...state.ui, language: value } }));
  },
  setSession: (value) =>
    set((state) => ({ session: { ...state.session, ...value } })),
  setData: ({ user, friends, convs, messagesByConv }) =>
    set({ userProfile: user, friends, convs, messagesByConv }),
  addToast: (toast) =>
    set((state) => ({
      ui: {
        ...state.ui,
        toast: [...state.ui.toast, { id: createId(), ...toast }],
      },
    })),
  removeToast: (id) =>
    set((state) => ({
      ui: {
        ...state.ui,
        toast: state.ui.toast.filter((item) => item.id !== id),
      },
    })),
  setConfirm: (confirm) =>
    set((state) => ({ ui: { ...state.ui, confirm } })),
}));
