using Microsoft.AspNetCore.Mvc;

namespace HAL_Opcenter_OEE_UI.Controllers;

public class HomeController : Controller
{
    public IActionResult Index() => View();
}
