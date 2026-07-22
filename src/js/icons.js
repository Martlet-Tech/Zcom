import { createElement, createIcons } from 'lucide';
import { Pin, ClipboardList, Minus, Maximize2, X, ChevronDown, Settings, RefreshCw, Trash2, Search, FolderOpen, Upload, Save, Plus, Download, GripVertical, Square, CheckSquare } from 'lucide';

const iconMap = {
  Pin,
  ClipboardList,
  Minus,
  Maximize2,
  X,
  ChevronDown,
  Settings,
  RefreshCw,
  Trash2,
  Search,
  FolderOpen,
  Upload,
  Save,
  Plus,
  Download,
  GripVertical,
  Square,
  CheckSquare,
};

export function initIcons() {
  createIcons({ icons: iconMap });
}

export { createElement, Upload, Square, GripVertical, X, CheckSquare };

export function setButtonIcon(btn, iconDef, text) {
  btn.innerHTML = '';
  btn.appendChild(createElement(iconDef));
  if (text) btn.appendChild(document.createTextNode(' ' + text));
}
