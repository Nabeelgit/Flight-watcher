const cameraBtn = document.getElementById("camera-btn");

let heading = null;
let pitch = null;

// Device orientation
function handleOrientation(event) {
    heading = event.alpha;
    pitch = event.beta;

    console.log("Heading:", heading);
    console.log("Pitch:", pitch);
}

cameraBtn.addEventListener("click", async () => {

    // iPhone requires permission
    if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
        try {
            const permission =
                await DeviceOrientationEvent.requestPermission();

            if (permission !== "granted") {
                console.log("Orientation permission denied");
                return;
            }
        } catch (err) {
            console.error(err);
            return;
        }
    }

    window.addEventListener(
        "deviceorientation",
        handleOrientation
    );

    navigator.geolocation.getCurrentPosition(
        (position) => {

            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            alert(
                `Latitude: ${latitude}
    Longitude: ${longitude}
    Accuracy: ${accuracy} meters

    Heading: ${heading}
    Pitch: ${pitch}`
            );
        },
        (error) => {
            alert(`Location Error: ${error.message}`);
        }
    );
});