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

