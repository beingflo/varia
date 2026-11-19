// The service is one binary: the API, and the built UI from the same origin so COOP/COEP and the
// sync endpoint line up.
mod app;
mod limits;
mod store;

pub use app::{AppState, Config, router};
pub use store::Store;
