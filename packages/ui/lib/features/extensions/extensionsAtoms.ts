import type { LoadedExtension } from "@/features/extensions/types";
import { atom } from "jotai";

export const loadedExtensionsAtom = atom<LoadedExtension[]>([]);
