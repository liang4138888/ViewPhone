import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

type Props = {
  image: {
    url: string;
    title: string;
    regions?: Array<{
      type: string;
      title: string;
      region?: { x: number; y: number; width: number; height: number };
    }>;
  };
  onClose: () => void;
};

export function ScreenshotViewer({ image, onClose }: Props) {
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number }>();
  const [fitWidth, setFitWidth] = useState<number>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const changeZoom = (next: number) => setZoom(
    Math.min(4, Math.max(0.5, Math.round(next * 10) / 10)),
  );

  useEffect(() => {
    setZoom(1);
    setNaturalSize(undefined);
    setFitWidth(undefined);
  }, [image.url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return undefined;
    const resize = () => {
      const availableWidth = Math.max(1, canvas.clientWidth - 2);
      const availableHeight = Math.max(1, canvas.clientHeight - 2);
      const aspectRatio = naturalSize.width / naturalSize.height;
      setFitWidth(Math.min(availableWidth, availableHeight * aspectRatio));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [naturalSize]);

  return (
    <div
      className="test-image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={image.title}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="test-image-viewer-header">
        <strong>{image.title}</strong>
        <button className="icon-button" onClick={onClose} aria-label="关闭截图放大">
          <Icon name="close" />
        </button>
      </div>
      <div
        className="test-image-viewer-canvas"
        ref={canvasRef}
        onWheel={(event) => {
          event.preventDefault();
          changeZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2));
        }}
        onPointerDown={(event) => {
          const canvas = canvasRef.current;
          if (!canvas || event.button !== 0) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: canvas.scrollLeft,
            top: canvas.scrollTop,
          };
          canvas.setPointerCapture(event.pointerId);
          canvas.classList.add('dragging');
        }}
        onPointerMove={(event) => {
          const canvas = canvasRef.current;
          if (!canvas || !drag.current) return;
          canvas.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
          canvas.scrollTop = drag.current.top - (event.clientY - drag.current.y);
        }}
        onPointerUp={(event) => {
          const canvas = canvasRef.current;
          drag.current = undefined;
          canvas?.classList.remove('dragging');
          canvas?.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          canvasRef.current?.classList.remove('dragging');
        }}
      >
        <div
          className="test-image-viewer-image"
          style={{ width: fitWidth ? `${fitWidth * zoom}px` : `${zoom * 100}%` }}
        >
          <img
            src={image.url}
            alt={image.title}
            onLoad={(event) => setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })}
          />
          {(image.regions || []).map((item, index) => item.region && (
            <span
              key={`${item.title}-${index}`}
              className={`viewer-difference-region difference-${item.type}`}
              style={{
                left: `${item.region.x / 10}%`,
                top: `${item.region.y / 10}%`,
                width: `${item.region.width / 10}%`,
                height: `${item.region.height / 10}%`,
              }}
            >
              <b>{index + 1}</b>
            </span>
          ))}
        </div>
      </div>
      <div className="test-image-viewer-controls">
        <button onClick={() => changeZoom(zoom - 0.25)} disabled={zoom <= 0.5} aria-label="缩小截图">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => changeZoom(zoom + 0.25)} disabled={zoom >= 4} aria-label="放大截图">＋</button>
        <button className="test-viewer-reset" onClick={() => setZoom(1)}>适应窗口</button>
        <span>{image.regions?.length ? '默认适应窗口 · 滚轮缩放 · 红框为 UI 差异' : '默认适应窗口 · 滚轮缩放 · 拖动画面平移'}</span>
      </div>
    </div>
  );
}
