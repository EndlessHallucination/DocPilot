/**
 * React binding for the vanilla annotation store.
 */

import { useStore } from "zustand";
import { annotationStore, type AnnotationState } from "../state/annotationStore";

export const useAnnotationStore = <T,>(selector: (s: AnnotationState) => T): T =>
    useStore(annotationStore, selector);