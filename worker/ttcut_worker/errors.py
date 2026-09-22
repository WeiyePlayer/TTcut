class WorkerError(Exception):
    code = "ANALYSIS_FAILED"
    recoverable = True


class InvalidRequestError(WorkerError):
    code = "INVALID_REQUEST"


class VideoError(WorkerError):
    code = "VIDEO_UNREADABLE"


class WeightError(WorkerError):
    code = "WEIGHT_MISSING"


class ModelResourceError(WorkerError):
    code = "MODEL_RESOURCE_ERROR"


class DeviceError(WorkerError):
    code = "DEVICE_UNAVAILABLE"


class InferenceError(WorkerError):
    code = "INFERENCE_FAILED"


class DirectMLFallbackRequired(InferenceError):
    code = "DIRECTML_FALLBACK_REQUIRED"

    def __init__(self, message: str, *, retry_smaller_batch: bool = True):
        super().__init__(message)
        self.retry_smaller_batch = retry_smaller_batch


class CalibrationError(WorkerError):
    code = "INVALID_CALIBRATION"


class AnalysisRoiError(WorkerError):
    code = "ANALYSIS_ROI_FAILED"
    recoverable = False


class AutoCalibrationError(CalibrationError):
    code = "AUTO_CALIBRATION_FAILED"


class TableModelResourceError(ModelResourceError):
    code = "TABLE_MODEL_RESOURCE_ERROR"


class TimestampError(WorkerError):
    code = "INVALID_TIMESTAMPS"
