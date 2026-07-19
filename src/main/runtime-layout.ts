export const ANALYSIS_PYTHON_VERSION = '3.12.13' as const;
export const ANALYSIS_TORCH_VERSION = '2.12.1' as const;
export const ANALYSIS_RUNTIME_ID = `${ANALYSIS_PYTHON_VERSION}-${ANALYSIS_TORCH_VERSION}` as const;

export const ANALYSIS_RUNTIME_VARIANTS = ['cpu', 'cu126'] as const;
export type AnalysisRuntimeVariant = typeof ANALYSIS_RUNTIME_VARIANTS[number];

export function analysisRuntimeDirectory(variant: AnalysisRuntimeVariant): string {
  return `analysis-runtime/${ANALYSIS_RUNTIME_ID}/${variant}`;
}

export function analysisRuntimePython(variant: AnalysisRuntimeVariant): string {
  return `${analysisRuntimeDirectory(variant)}/python.exe`;
}

export function expectedTorchVersion(variant: AnalysisRuntimeVariant): string {
  return `${ANALYSIS_TORCH_VERSION}+${variant}`;
}

export const ACTIVE_RUNTIME_MANIFEST = 'active-runtime.json' as const;
