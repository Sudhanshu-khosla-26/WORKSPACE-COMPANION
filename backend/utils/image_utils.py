import cv2
import numpy as np
import base64

class ImageProcessor:
    def decode_base64_image(self, b64_or_bytes) -> np.ndarray:
        if isinstance(b64_or_bytes, bytes):
            image = cv2.imdecode(np.frombuffer(b64_or_bytes, np.uint8), cv2.IMREAD_COLOR)
        else:
            if ',' in b64_or_bytes:
                b64_or_bytes = b64_or_bytes.split(',')[1]
            try:
                img_data = base64.b64decode(b64_or_bytes)
                image = cv2.imdecode(np.frombuffer(img_data, np.uint8), cv2.IMREAD_COLOR)
            except:
                image = None
        return image

    def resize_image(self, image: np.ndarray) -> np.ndarray:
        if image is None: return None
        if image.shape[0] > 480 or image.shape[1] > 640:
            return cv2.resize(image, (640, 480))
        return image

    def convert_to_grayscale(self, image: np.ndarray) -> np.ndarray:
        if image is None: return None
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    def cleanup_image(self, image: np.ndarray):
        pass

image_processor = ImageProcessor()
