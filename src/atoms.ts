import { atom } from "jotai";

export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
}

export const authUserAtom = atom<AuthUser | null>(null);
export const authSigningInAtom = atom(false);
