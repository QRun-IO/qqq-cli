import { Component, type ReactNode } from "react";
import { T } from "./theme";

interface State
{
   error: Error | null;
}

/** A screen that throws shows its error in place instead of taking the whole terminal down. */
export class ScreenErrorBoundary extends Component<{ children: ReactNode; width: number; resetKey: string }, State>
{
   override state: State = { error: null };

   static getDerivedStateFromError(error: Error): State
   {
      return { error };
   }

   override componentDidUpdate(prev: { resetKey: string })
   {
      if (prev.resetKey !== this.props.resetKey && this.state.error)
      {
         this.setState({ error: null });
      }
   }

   override render()
   {
      if (this.state.error)
      {
         return (
            <box flexDirection="column" border borderColor={T.err} width={this.props.width} title=" Screen error ">
               <text fg={T.err}>{` ${this.state.error.message}`}</text>
               <text fg={T.dim}>{" Esc goes back · F5 retries · the error is a bug in this screen, please report the steps"}</text>
            </box>
         );
      }
      return this.props.children;
   }
}
