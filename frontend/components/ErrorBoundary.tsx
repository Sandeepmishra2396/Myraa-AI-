import React, { Component, ErrorInfo, ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Production Error Boundary for MYRAA UI components.
 * Catches unhandled runtime render exceptions, prevents white-screen crashes,
 * and allows users to gracefully recover without reloading the application.
 */
export interface ErrorBoundary extends Component<Props, State> {
  props: Props;
  setState(state: Partial<State> | ((prevState: State) => Partial<State>), callback?: () => void): void;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  constructor(props: Props) {
    super(props);
    this.props = props;
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught UI error:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 rounded-2xl border border-rose-500/30 bg-rose-950/40 backdrop-blur-xl text-left max-w-lg mx-auto my-4 shadow-2xl">
          <div className="flex items-center gap-3 text-rose-300 font-mono text-sm font-semibold mb-2">
            <CircleAlert size={20} className="text-rose-400 shrink-0" />
            <span>{this.props.fallbackTitle || "Interface Module Recovered"}</span>
          </div>
          <p className="text-xs text-rose-200/90 font-mono leading-relaxed mb-4 break-words">
            {this.state.error?.message || "An unexpected error occurred in this view."}
          </p>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-mono font-medium transition cursor-pointer border border-white/10"
          >
            <RefreshCw size={14} />
            <span>Restore Component</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
